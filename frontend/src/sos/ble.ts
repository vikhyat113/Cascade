// BleMeshTransport (spec §13): the real Bluetooth relay, through the native "Mesh" plugin
// (android/.../mesh/MeshPlugin.kt). Same interface as the simulated mesh. Any phone running it relays
// packets; a phone that can reach the dispatch server also acts as the gateway: it posts SOS packets
// it receives and broadcasts the server's acknowledgement back as an `ack` packet.
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { CONFIG } from "../config";
import type { Desk, Dispatch, MeshTransport, SosPacket, SosType } from "./types";

type Wire = { id: number; type: number; to: number; ttl: number; hop: number; lat: number; lon: number; ts: number };
type NativeStatus = { running: boolean; peers: number; relayed: number; sent: number; lastPacketAt: number | null };
interface MeshNative {
  start(o: { title: string; text: string }): Promise<NativeStatus>;
  stop(): Promise<NativeStatus>;
  status(): Promise<NativeStatus>;
  broadcast(p: Wire): Promise<NativeStatus>;
  addListener(ev: "packet", f: (p: Wire & { rssi: number }) => void): Promise<PluginListenerHandle>;
  addListener(ev: "log", f: (m: { message: string }) => void): Promise<PluginListenerHandle>;
}
const Native = registerPlugin<MeshNative>("Mesh");

// 2-bit codes in the packet's type byte (see BleMesh.kt)
const TYPES: (SosType | "ack")[] = ["danger", "medical", "unsure", "ack"];
const TO: (Desk | "test")[] = ["police", "hospital", "contact", "test"];

export interface Heard { t: number; type: string; to: string; id: number; hop: number; rssi: number }

export class BleMeshTransport implements MeshTransport {
  running = false;
  stats: NativeStatus = { running: false, peers: 0, relayed: 0, sent: 0, lastPacketAt: null };
  heard: Heard[] = [];
  logs: string[] = [];
  private cbs = new Set<(p: SosPacket) => void>();
  private watchers = new Set<() => void>();
  private queue: SosPacket[] = [];
  private awaiting = new Map<string, SosPacket>();
  private handles: PluginListenerHandle[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private dispatch: Dispatch) {}

  /** Only inside the Android app with the plugin compiled in. */
  static available(): boolean { return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("Mesh"); }

  async start(words: { title: string; text: string }): Promise<void> {
    if (!BleMeshTransport.available()) throw new Error("only in the Android app");
    if (!this.handles.length) {
      this.handles.push(await Native.addListener("packet", (w) => this.onPacket(w)));
      this.handles.push(await Native.addListener("log", (m) => this.log(m.message)));
    }
    this.stats = await Native.start(words);
    this.running = true;
    this.timer ??= setInterval(() => void this.tick(), CONFIG.mesh.gatewayRetryMs);
    this.log("started");
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.running = false;
    try { this.stats = await Native.stop(); } catch { /* already stopped */ }
    this.changed();
  }

  broadcast(p: SosPacket): void {
    Native.broadcast(BleMeshTransport.wire(p)).then((s) => { this.stats = s; this.changed(); }).catch((e) => this.log(`send failed: ${e?.message ?? e}`));
  }
  /** A packet that is relayed and shown, but never posted to the dispatch server (two-phone check). */
  sendTest(at: { lat: number; lon: number }): void {
    const id = Math.floor(Math.random() * 2 ** 31) + 1;
    Native.broadcast({ id, type: 2, to: 3, ttl: CONFIG.mesh.ttl, hop: 0, lat: at.lat, lon: at.lon, ts: Math.round(Date.now() / 1000) })
      .then((s) => { this.stats = s; this.log(`test packet ${id} sent`); }).catch((e) => this.log(`test failed: ${e?.message ?? e}`));
  }
  onReceive(cb: (p: SosPacket) => void): () => void { this.cbs.add(cb); return () => { this.cbs.delete(cb); }; }
  status() { return { peers: this.stats.peers, mode: "ble" as const }; }
  watch(f: () => void): () => void { this.watchers.add(f); return () => { this.watchers.delete(f); }; }

  static wire(p: SosPacket): Wire {
    return { id: p.id, type: TYPES.indexOf(p.type), to: TO.indexOf(p.to ?? "police"), ttl: p.ttl, hop: p.hop, lat: p.lat, lon: p.lon, ts: p.ts };
  }
  static unwire(w: Wire): { packet: SosPacket | null; to: Desk | "test" } {
    const to = TO[w.to] ?? "police";
    const type = TYPES[w.type] ?? "unsure";
    return { to, packet: to === "test" ? null : { id: w.id, type, to, lat: w.lat, lon: w.lon, ts: w.ts, hop: w.hop, ttl: w.ttl } };
  }
  private static key(p: SosPacket) { return `${p.type}:${p.id}:${p.to ?? ""}`; }

  private onPacket(w: Wire & { rssi: number }): void {
    const { packet, to } = BleMeshTransport.unwire(w);
    this.heard.unshift({ t: Date.now(), type: TYPES[w.type] ?? "?", to, id: w.id, hop: w.hop, rssi: w.rssi });
    if (this.heard.length > 30) this.heard.pop();
    if (packet?.type === "ack") this.cbs.forEach((cb) => cb(packet));
    else if (packet) { this.queue.push(packet); void this.tick(); }       // maybe we are the gateway
    this.changed();
  }

  /** Gateway: post SOS packets heard over Bluetooth when the server is reachable; relay its acknowledgements. */
  private async tick(): Promise<void> {
    if (this.busy || !this.running) return;
    this.busy = true;
    try {
      this.stats = await Native.status();
      if (this.queue.length || this.awaiting.size) {
        if (!(await this.dispatch.reachable())) return;                 // store and forward: try again later
        for (const p of [...this.queue]) {
          if (p.type === "ack") continue;
          if (!(await this.dispatch.send({ id: String(p.id), type: p.type, to: p.to ?? "police", lat: p.lat, lon: p.lon, ts: p.ts, via: "mesh", hops: p.hop }))) continue;
          this.queue = this.queue.filter((q) => q !== p);
          this.awaiting.set(BleMeshTransport.key(p), p);
          this.log(`gateway: posted ${p.type} ${p.id} (${p.hop} hops)`);
        }
        for (const [k, p] of [...this.awaiting]) {
          if (!(await this.dispatch.acked(String(p.id)))) continue;
          this.awaiting.delete(k);
          this.broadcast({ id: p.id, type: "ack", to: p.to, lat: p.lat, lon: p.lon, ts: Math.round(Date.now() / 1000), hop: 0, ttl: CONFIG.mesh.ttl });
          this.log(`gateway: acknowledged ${p.id}, sent back`);
        }
      }
    } catch (e) {
      this.log(`gateway: ${(e as Error)?.message ?? e}`);
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  private log(m: string): void {
    this.logs.unshift(`${new Date().toLocaleTimeString()} ${m}`);
    if (this.logs.length > 30) this.logs.pop();
    this.changed();
  }
  private changed(): void { this.watchers.forEach((f) => f()); }
}

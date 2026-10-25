// SimulatedMeshTransport (spec §10): a few virtual phones passing an SOS hop by hop. Gossip forwarding,
// dedupe by packet id, hop limit, and store-and-forward at a "gateway" phone that posts to the dispatch
// server once it has signal; the server's acknowledgement travels back as an `ack` packet.
// Shown only in the Demo drawer, labelled "simulated".
import { CONFIG } from "../config";
import type { Dispatch, MeshTransport, SosPacket } from "./types";

export interface MeshNode { id: number; x: number; y: number; label: string }
export interface MeshEvent { t: number; from: number; to: number; kind: "relay" | "dup" | "store" | "post" | "ack"; packet: string }

// layout for the drawer (0..1); node 0 = this phone, last = gateway. Shortest way to the gateway is 3 hops.
const NODES: MeshNode[] = [
  { id: 0, x: 0.08, y: 0.55, label: "this phone" }, { id: 1, x: 0.3, y: 0.2 }, { id: 2, x: 0.32, y: 0.8 },
  { id: 3, x: 0.55, y: 0.35 }, { id: 4, x: 0.66, y: 0.78 }, { id: 5, x: 0.92, y: 0.5, label: "gateway (has signal)" },
].map((n) => ({ label: `phone ${n.id}`, ...n }));
const LINKS: [number, number][] = [[0, 1], [0, 2], [1, 3], [2, 3], [2, 4], [3, 4], [4, 5], [3, 5]];

export class SimulatedMeshTransport implements MeshTransport {
  readonly nodes: MeshNode[];
  readonly links: [number, number][];
  readonly gateway: number;
  gatewaySignal = true;                      // Demo: switch off to watch packets wait at the gateway
  relayed = 0;
  lastPacketAt: number | null = null;
  events: MeshEvent[] = [];
  private seen: Set<string>[];
  private queue: SosPacket[] = [];
  private awaiting = new Map<string, SosPacket>();
  private cbs = new Set<(p: SosPacket) => void>();
  private watchers = new Set<() => void>();
  private busy = false;
  private timer: ReturnType<typeof setInterval>;

  constructor(private dispatch: Dispatch, private cfg = CONFIG.mesh, private random: () => number = Math.random) {
    this.nodes = NODES.slice(0, cfg.nodes);
    this.gateway = this.nodes.length - 1;
    this.links = LINKS.filter(([a, b]) => a <= this.gateway && b <= this.gateway);
    this.seen = this.nodes.map(() => new Set());
    this.timer = setInterval(() => void this.gatewayTick(), cfg.gatewayRetryMs);
  }

  broadcast(p: SosPacket): void { this.originate(0, p); }
  onReceive(cb: (p: SosPacket) => void): () => void { this.cbs.add(cb); return () => { this.cbs.delete(cb); }; }
  status() { return { peers: this.neighbours(0).length, mode: "simulated" as const }; }
  stats() { return { relayed: this.relayed, lastPacketAt: this.lastPacketAt, waiting: this.queue.length, gatewaySignal: this.gatewaySignal }; }
  /** Redraw hook for the Demo drawer. */
  watch(f: () => void): () => void { this.watchers.add(f); return () => { this.watchers.delete(f); }; }
  dispose(): void { clearInterval(this.timer); }

  neighbours(n: number): number[] { return this.links.flatMap(([a, b]) => (a === n ? [b] : b === n ? [a] : [])); }
  static key(p: SosPacket): string { return `${p.type}:${p.id}:${p.to ?? ""}`; }

  private log(e: Omit<MeshEvent, "t">): void {
    this.events.push({ t: Date.now(), ...e });
    if (this.events.length > 200) this.events.shift();
    this.watchers.forEach((f) => f());
  }

  private originate(node: number, p: SosPacket): void {
    this.seen[node].add(SimulatedMeshTransport.key(p));
    this.forward(node, p, -1);
  }

  private forward(node: number, p: SosPacket, from: number): void {
    if (p.hop >= p.ttl) return;                                   // hop limit
    const [lo, hi] = this.cfg.hopMs;
    for (const n of this.neighbours(node)) {
      if (n === from) continue;
      setTimeout(() => this.receive(n, { ...p, hop: p.hop + 1 }, node), lo + this.random() * (hi - lo));
    }
  }

  private receive(node: number, p: SosPacket, from: number): void {
    const key = SimulatedMeshTransport.key(p);
    if (this.seen[node].has(key)) { this.log({ from, to: node, kind: "dup", packet: key }); return; }   // dedupe by id
    this.seen[node].add(key);
    this.relayed++;
    this.lastPacketAt = Date.now();
    this.log({ from, to: node, kind: "relay", packet: key });
    if (node === 0 && p.type === "ack") this.cbs.forEach((cb) => cb(p));
    if (node === this.gateway && p.type !== "ack") {
      this.queue.push(p);
      this.log({ from: node, to: node, kind: "store", packet: key });
      void this.gatewayTick();
    }
    this.forward(node, p, from);
  }

  /** Store-and-forward: post waiting packets when the gateway has signal; relay acknowledgements back. */
  private async gatewayTick(): Promise<void> {
    if (this.busy || !this.gatewaySignal) return;
    this.busy = true;
    try {
      for (const p of [...this.queue]) {
        if (p.type === "ack") continue;
        const ok = await this.dispatch.send({ id: String(p.id), type: p.type, to: p.to ?? "police", lat: p.lat, lon: p.lon, ts: p.ts, via: "mesh", hops: p.hop });
        if (!ok) continue;
        this.queue = this.queue.filter((q) => q !== p);
        this.awaiting.set(SimulatedMeshTransport.key(p), p);
        this.log({ from: this.gateway, to: this.gateway, kind: "post", packet: SimulatedMeshTransport.key(p) });
      }
      for (const [key, p] of [...this.awaiting]) {
        if (!(await this.dispatch.acked(String(p.id)))) continue;
        this.awaiting.delete(key);
        const ack: SosPacket = { id: p.id, type: "ack", to: p.to, lat: p.lat, lon: p.lon, ts: Math.round(Date.now() / 1000), hop: 0, ttl: this.cfg.ttl };
        this.log({ from: this.gateway, to: this.gateway, kind: "ack", packet: SimulatedMeshTransport.key(ack) });
        this.originate(this.gateway, ack);
      }
    } finally {
      this.busy = false;
    }
  }
}

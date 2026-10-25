// Live state: the fact store (what the planner may see), source on/off + last update, and the
// simulator's ground truth (which the planner NEVER reads; it only learns through facts).
import { LIVE_SOURCES, SOURCES, type SourceId } from "../config";
import { confidence, status, view, type Fact, type FactView, type Status } from "./freshness";
import type { Clock } from "./time";
import { Rng } from "./util";
import type { World } from "./world";

export interface SourceState { id: SourceId; enabled: boolean; lastOk: number | null; burstUntil: number | null; history: { t: number; status: Status; confidence: number }[]; lastStatus: Status | null }

export interface Closure { name: string; reason: string; kind: "closure" | "accident" | "waterlogging"; edges: number[]; lat: number; lon: number; since: number }

export interface Truth {
  rain: string | null; rainSince: number | null;
  closures: Map<string, Closure>; lifted: Map<string, [number, Closure]>;
  cancelledTrips: Set<string>; tripDelay: Map<string, number>; scheduleConflicts: Map<string, number>;
  accidents: Map<number, number>; cabMultiplier: number;
}

export interface EventEntry { seq: number; t: number; kind: string; message: string; severity: "info" | "warn" | "alert" }

export class State {
  store = new Map<string, Fact>();
  sources: Record<SourceId, SourceState>;
  truth: Truth = { rain: null, rainSince: null, closures: new Map(), lifted: new Map(), cancelledTrips: new Set(), tripDelay: new Map(), scheduleConflicts: new Map(), accidents: new Map(), cabMultiplier: 1 };
  rng: Rng;
  events: EventEntry[] = [];
  eventSeq = 0;
  version = 0;
  online = true;                 // phone has network: when false, no live information arrives
  realWeather: Fact | null = null;   // latest real Open-Meteo observation (set by the app's probe)
  private seq = 0;

  constructor(public world: World, public clock: Clock, seed?: number) {
    this.rng = new Rng(seed ?? world.meta.seed);
    this.sources = Object.fromEntries((Object.keys(SOURCES) as SourceId[]).map((id) =>
      [id, { id, enabled: true, lastOk: null, burstUntil: null, history: [], lastStatus: null }])) as unknown as Record<SourceId, SourceState>;
  }

  now(): number { return this.clock.now(); }
  put(f: Fact): void { this.store.set(f.key, f); }
  get(k: string): Fact | undefined { return this.store.get(k); }
  withPrefix(p: string): Fact[] { const out: Fact[] = []; for (const [k, f] of this.store) if (k.startsWith(p)) out.push(f); return out; }
  statusOf(f: Fact | null | undefined): Status { return status(f, this.now()); }
  confOf(f: Fact | null | undefined): number { return confidence(f, this.now()); }
  view(f: Fact | null | undefined, o: Partial<FactView> & { key?: string } = {}): FactView { return view(f, this.now(), o); }
  available(sid: SourceId): boolean { return this.sources[sid].enabled; }
  /** Live information can arrive: source switched on and the phone online. */
  liveOn(sid: SourceId): boolean { return this.sources[sid].enabled && this.online; }

  private staticObservedAt(sid: SourceId): number | null {
    const w = this.world;
    switch (sid) {
      case "osm_map": return w.mapAt;
      case "osm_hours": return w.poisAt;
      case "weather_forecast": return w.weatherFetchedAt;
      case "transit_schedule": return w.scheduleGeneratedAt;
      case "incident_history": return w.poisAt;
      default: return null;
    }
  }

  heartbeat(sid: SourceId): Fact | null {
    const s = this.sources[sid];
    const c = SOURCES[sid];
    const obs = c.live ? s.lastOk : s.enabled ? this.staticObservedAt(sid) : null;
    if (obs == null) return null;
    return { key: `source:${sid}`, value: "ok", source: sid, synthetic: c.synthetic, observedAt: obs, ttlS: c.ttlS, reliability: c.reliability, kind: c.kind };
  }

  sourceView(sid: SourceId): FactView {
    const s = this.sources[sid];
    const note = s.enabled ? null : SOURCES[sid].live ? "switched off" : "unavailable";
    return this.view(this.heartbeat(sid), { key: `source:${sid}`, source: sid, synthetic: SOURCES[sid].synthetic, note });
  }

  /** Sample each source's status; return transitions (sid, old, new). */
  recordHistory(): [SourceId, Status, Status][] {
    const out: [SourceId, Status, Status][] = [];
    const t = this.now();
    for (const sid of Object.keys(this.sources) as SourceId[]) {
      const s = this.sources[sid];
      const v = this.sourceView(sid);
      s.history.push({ t, status: v.status, confidence: v.confidence });
      if (s.history.length > 40) s.history.shift();
      if (s.lastStatus && s.lastStatus !== v.status) out.push([sid, s.lastStatus, v.status]);
      s.lastStatus = v.status;
    }
    return out;
  }

  logEvent(kind: string, message: string, severity: EventEntry["severity"] = "info"): void {
    this.events.push({ seq: ++this.eventSeq, t: this.now(), kind, message, severity });
    if (this.events.length > 300) this.events.shift();
  }
  eventsSince(seq: number): EventEntry[] { return this.events.filter((e) => e.seq > seq); }
  nextId(p: string): string { return `${p}${++this.seq}`; }

  /** "offline" when no live information is coming in (phone offline or every live source off/too old). */
  connection(): "live" | "offline" {
    if (!this.online) return "offline";
    return LIVE_SOURCES.some((sid) => this.sources[sid].enabled && ["KNOWN", "PROBABLE"].includes(this.sourceView(sid).status)) ? "live" : "offline";
  }
}

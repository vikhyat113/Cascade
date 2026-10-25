// The engine facade: everything the app (via the worker) and the tests talk to.
import { CONFIG, SOURCES, type SourceId } from "../config";
import type { Lang } from "../copy/format";
import { RANK, type Fact } from "./freshness";
import { needNow } from "./needs";
import type { PlanRequest } from "./planner";
import { Replanner, type ActivePlan } from "./replanner";
import { OpenCache, hoursCoverage } from "./services";
import { simplePlaces, SimpleViewBuilder, type SimpleView } from "./simpleView";
import { FeedSimulator } from "./sim/feeds";
import { applyEvent, setSource, type PlanContext, type SimEvent, type SourceArg } from "./sim/events";
import { State } from "./state";
import { AppClock, type Clock } from "./time";
import type { World } from "./world";

export interface SourceInfo { id: SourceId; label: string; live: boolean; synthetic: boolean; enabled: boolean; status: string; confidence: number; ageS: number | null; reliability: number; ttlS: number; history: string[] }

export class Engine {
  state!: State; feeds!: FeedSimulator; cache!: OpenCache; replanner!: Replanner;
  private last = 0;

  constructor(public world: World, public clock: Clock = new AppClock(), private opts: { live?: boolean; warmup?: boolean; seed?: number } = {}) {
    this.reset(clock, opts.warmup ?? true);
  }

  reset(clock: Clock = this.clock, warmup = true): void {
    const keepOnline = this.state?.online ?? true;
    const keepWeather = this.state?.realWeather ?? null;
    this.clock = clock;
    this.state = new State(this.world, clock, this.opts.seed);
    this.state.online = keepOnline;
    this.state.realWeather = keepWeather;
    this.feeds = new FeedSimulator(this.state, this.opts.live ?? true);
    this.cache = new OpenCache();
    this.replanner = new Replanner(this.state, this.cache);
    if (warmup) this.feeds.warmup(CONFIG.sim.warmupS);
    this.last = clock.now();
    this.state.recordHistory();
  }

  // ---- time --------------------------------------------------------------------------------------
  private step(dtS: number): void {
    const s = this.state;
    this.feeds.tick(dtS);
    for (const [sid, old, nw] of s.recordHistory()) {
      const v = s.sourceView(sid);
      const up = RANK[nw] > RANK[old];
      const why = SOURCES[sid].live && !up && v.ageS !== null ? ` (no update for ${Math.round(v.ageS / 60)} min)` : "";
      s.logEvent("source", `${SOURCES[sid].label}: ${old} -> ${nw}${why}`, up ? "info" : nw === "OUTDATED" || nw === "UNKNOWN" ? "alert" : "warn");
    }
  }

  /** Catch up with the clock (called every CONFIG.sim.tickMs in the app). */
  tick(): boolean {
    const now = this.clock.now();
    const dt = (now - this.last) / 1000;
    if (dt <= 0.5) return false;
    // big jumps (clock set forward) are walked in steps so facts age naturally
    const n = Math.max(1, Math.ceil(dt / 120));
    for (let i = 1; i <= n; i++) { this.last += (dt * 1000) / n; this.step(dt / n); }
    this.last = now;
    this.replanner.tickAll();
    this.state.version++;
    return true;
  }

  advance(seconds: number, stepS = CONFIG.sim.stepS, replanEachStep = false): void {
    const n = Math.max(1, Math.ceil(seconds / stepS));
    for (let i = 0; i < n; i++) { this.clock.advance(seconds / n); this.step(seconds / n); if (replanEachStep) this.replanner.tickAll(); }
    this.last = this.clock.now();
    if (!replanEachStep) this.replanner.tickAll();
    this.state.version++;
  }

  setClock(o: { time?: number; speed?: number; paused?: boolean }): void {
    if (o.time !== undefined && o.time > this.clock.now() + 1000) {           // jump forward: let facts age
      const delta = (o.time - this.clock.now()) / 1000;
      this.advance(delta, Math.max(CONFIG.sim.stepS, delta / 200));
      this.clock.set({ speed: o.speed, paused: o.paused });
    } else {
      this.clock.set(o);
      // jump back (more than a minute): start the night fresh; a tiny step back is just a re-sync
      if (o.time !== undefined && o.time < this.last - 60000) { this.reset(this.clock, true); }
    }
    this.last = this.clock.now();
  }

  // ---- planning ------------------------------------------------------------------------------------
  get active(): ActivePlan | null { return [...this.replanner.plans.values()][0] ?? null; }

  plan(req: PlanRequest): ActivePlan { return this.replanner.create(req); }

  choose(planId: string): boolean { const ap = this.active; return !!ap && this.replanner.choose(ap, planId); }

  endTrip(): void { this.replanner.plans.clear(); }

  view(lang: Lang): SimpleView | null {
    const ap = this.active;
    if (!ap?.planset) return null;
    return new SimpleViewBuilder(ap.planset, lang, this.state.now(), this.world.city, this.state.connection(), { name: ap.request.destination.name, kind: ap.request.destination.kind }).build();
  }

  needNow(kind: string, lat: number, lon: number, lang: Lang) { return simplePlaces(needNow(this.state, this.cache, kind, lat, lon), lang); }

  /** Nearest help: police and hospital / clinic (with ways there). */
  help(lat: number, lon: number, lang: Lang) {
    return { police: this.needNow("police", lat, lon, lang)[0] ?? null, hospital: this.needNow("doctor", lat, lon, lang)[0] ?? null };
  }

  // ---- demo controls --------------------------------------------------------------------------------
  planContext(): PlanContext {
    const ap = this.active;
    if (!ap) return {};
    const ctx: PlanContext = { near: [ap.request.origin.lat, ap.request.origin.lon] };
    if (ap.pinned) {
      ctx.edges = ap.pinned.legs.flatMap((l) => l.edges.map(([e]) => e));
      ctx.route = ap.pinned.legs.find((l) => l.routeId)?.routeId;
    }
    const rec = ap.planset?.plans.find((p) => p.id === ap.planset?.recommendedId);
    const trip = rec?.segments.find((s) => s.tripId)?.tripId;
    if (trip) { ctx.trip = trip; ctx.route = ctx.route ?? trip.split("-")[0]; }
    return ctx;
  }

  outage(source: SourceArg, enabled: boolean): void { setSource(this.state, source, enabled); this.state.recordHistory(); }
  inject(ev: SimEvent): Record<string, unknown> { return applyEvent(this.state, ev, this.planContext()); }

  setOnline(online: boolean): void {
    if (this.state.online !== online) this.state.logEvent("network", online ? "phone back online" : "phone offline: no live information", online ? "info" : "warn");
    this.state.online = online;
  }

  /** A real Open-Meteo `current` reading from the app's probe (real data, not synthetic). */
  setRealWeather(current: Record<string, number | string | null>, observedAt: number): void {
    const c = SOURCES.weather;
    const f: Fact = { key: "weather:now", value: current, source: "weather", synthetic: false, observedAt, ttlS: c.ttlS, reliability: c.reliability, kind: "observed", note: "Open-Meteo current weather" };
    this.state.realWeather = f;
  }

  trust(): { sources: SourceInfo[]; hours: Record<string, number>; events: { t: string; message: string; severity: string }[]; now: number } {
    const s = this.state;
    return {
      now: s.now(),
      sources: (Object.keys(SOURCES) as SourceId[]).map((id) => {
        const v = s.sourceView(id), c = SOURCES[id];
        return { id, label: c.label, live: c.live, synthetic: c.synthetic, enabled: s.sources[id].enabled, status: v.status, confidence: v.confidence, ageS: v.ageS,
          reliability: c.reliability, ttlS: c.ttlS, history: s.sources[id].history.slice(-24).map((h) => h.status) };
      }),
      hours: hoursCoverage(s, s.now()),
      events: s.events.slice(-30).map((e) => ({ t: this.world.city.hhmm(e.t), message: e.message, severity: e.severity })),
    };
  }
}

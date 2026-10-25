// The engine runs here, off the UI thread, on the data bundled in the APK. No network needed.
// The UI talks to it through src/lib/engine.ts (request/response + a pushed view on every tick).
import { CONFIG } from "../config";
import type { Lang } from "../copy/format";
import { fetchBundle } from "./bundle";
import { Engine } from "./engine";
import type { Mode, Point, PlanRequest } from "./planner";
import { runScenario, SCENARIOS, type ScenarioResult } from "./scenarios";
import type { SimEvent, SourceArg } from "./sim/events";
import type { SimpleView } from "./simpleView";
import { AppClock } from "./time";
import { World } from "./world";

export interface Spot { lat: number; lon: number; name: string; kind?: "home" | "work" | "here" | null }
export interface TripAsk { from: Spot; to: Spot; when: string | null; by: string | null; modes?: Mode[] }
export interface Roads { major: Float32Array; majorOff: Uint32Array; minor: Float32Array; minorOff: Uint32Array }
export type Pushed =
  | { type: "view"; view: SimpleView | null }
  | { type: "status"; connection: "live" | "offline"; now: number; now_text: string };

let engine: Engine;
let lang: Lang = "en";
let lastView = "";
const results = new Map<string, ScenarioResult>();

const ready = (async () => {
  const world = new World(await fetchBundle());
  engine = new Engine(world, new AppClock(Date.now()), { live: true, warmup: true });
  setInterval(() => { engine.tick(); push(); }, CONFIG.sim.tickMs);
})();

const post = (m: Pushed) => (self as unknown as Worker).postMessage({ push: m });

/** The plain view without the technical plan set (only the Demo drawer asks for that). */
function plainView(): SimpleView | null {
  const v = engine.view(lang);
  return v ? { ...v, details: null as unknown as SimpleView["details"] } : null;
}

function push(force = false): void {
  const s = engine.state;
  post({ type: "status", connection: s.connection(), now: s.now(), now_text: engine.world.city.clock(s.now()) ?? "" });
  const v = plainView();
  const key = JSON.stringify(v);
  if (force || key !== lastView) { lastView = key; post({ type: "view", view: v }); }
}

function request(a: TripAsk): PlanRequest {
  const city = engine.world.city, now = engine.state.now();
  const start = a.when ? city.atNight(a.when, now) : now;
  const pt = (p: Spot): Point => ({ lat: p.lat, lon: p.lon, name: p.name || engine.world.nearestPlaceName(p.lat, p.lon) || "", kind: p.kind === "home" || p.kind === "work" ? p.kind : null });
  return { origin: pt(a.from), destination: pt(a.to), start, deadline: a.by ? city.atNight(a.by, start) : null,
    modes: a.modes ?? ["walk", "bus", "cab"], riskWeight: 1, maxWalkM: 2500 };
}

function roads(): Roads {
  const w = engine.world;
  const pack = (main: boolean) => {
    const pts: number[] = [], off: number[] = [0];
    for (let e = 0; e < w.m; e++) {
      if (!!w.isMain[e] !== main) continue;
      for (const c of w.egeom[e]) pts.push(c);
      off.push(pts.length);
    }
    return [new Float32Array(pts), new Uint32Array(off)] as const;
  };
  const [major, majorOff] = pack(true), [minor, minorOff] = pack(false);
  return { major, majorOff, minor, minorOff };
}

const handlers = {
  async init() {
    await ready;
    const m = engine.world.meta;
    return { city_name: m.city_name, center: m.center, radius_m: m.radius_m, ui_defaults: m.ui_defaults, real: m.real, synthetic: m.synthetic, sample: m.sample };
  },
  setLang(l: Lang) { lang = l; push(true); },
  plan(a: TripAsk) { engine.plan(request(a)); const v = plainView(); lastView = JSON.stringify(v); return v; },
  view() { return plainView(); },
  choose(planId: string) { engine.choose(planId); return plainView(); },
  endTrip() { engine.endTrip(); push(true); },
  where(lat: number, lon: number) { return engine.world.nearestPlaceName(lat, lon); },
  inArea(lat: number, lon: number) { return engine.world.inArea(lat, lon); },
  geocode(q: string) { return engine.world.geocode(q); },
  needNow(type: string, lat: number, lon: number) { return engine.needNow(type, lat, lon, lang); },
  help(lat: number, lon: number) { return engine.help(lat, lon, lang); },
  roads,
  setOnline(on: boolean) { engine.setOnline(on); push(); },
  setRealWeather(current: Record<string, number | string | null>, observedAt: number) { engine.setRealWeather(current, observedAt); },
  // ---- Demo drawer -----------------------------------------------------------------------------
  outage(source: SourceArg, enabled: boolean) { engine.outage(source, enabled); engine.replanner.tickAll(); push(); },
  inject(ev: SimEvent) { const r = engine.inject(ev); engine.replanner.tickAll(); push(); return r; },
  setClock(o: { time?: number; hhmm?: string; speed?: number; paused?: boolean }) {
    const time = o.hhmm ? engine.world.city.atNight(o.hhmm, engine.state.now()) : o.time;
    engine.setClock({ time, speed: o.speed, paused: o.paused });
    engine.replanner.tickAll();
    push(true);
  },
  timing() { const c = engine.clock as AppClock; return { deadline: engine.active?.planset?.deadline ?? null, now: c.now(), speed: c.paused ? 0 : c.speed }; },
  clock() { const c = engine.clock as AppClock; return { now: c.now(), speed: c.speed, paused: c.paused, now_text: engine.world.city.clock(c.now()) ?? "", rain: engine.state.truth.rain }; },
  sources() { return Object.fromEntries(Object.entries(engine.state.sources).map(([k, v]) => [k, v.enabled])); },
  trust() { return engine.trust(); },
  details() { return engine.active?.planset ?? null; },
  log() { return engine.active?.log ?? []; },
  scenarios() { return SCENARIOS.map((s) => ({ id: s.id, name: s.name, description: s.description ?? "" })); },
  runScenarios() { for (const sc of SCENARIOS) results.set(sc.id, runScenario(engine.world, sc)); return [...results.values()]; },
  results() { return [...results.values()]; },
  reset() { engine.reset(new AppClock(Date.now())); push(true); },
};
export type EngineApi = typeof handlers;

self.onmessage = async (ev: MessageEvent<{ id: number; op: keyof EngineApi; args: unknown[] }>) => {
  const { id, op, args } = ev.data;
  try {
    await ready;
    const fn = handlers[op] as (...a: unknown[]) => unknown;
    const result = await fn(...args);
    const transfer = op === "roads" ? Object.values(result as Roads).map((a) => (a as ArrayBufferView).buffer as ArrayBuffer) : [];
    (self as unknown as Worker).postMessage({ id, result }, transfer);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: String((e as Error)?.message ?? e) });
  }
};

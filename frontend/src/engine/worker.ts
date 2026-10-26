// The engine runs here, off the UI thread, on the data bundled in the APK. No network needed.
// The UI talks to it through src/lib/engine.ts (request/response + a pushed view on every tick).
import { CONFIG } from "../config";
import type { Lang } from "../copy/format";
import { fetchBundle } from "./bundle";
import { Engine } from "./engine";
import type { Mode, Point, PlanRequest } from "./planner";
import { SCENARIOS } from "./scenarios";
import type { SimEvent, SourceArg } from "./sim/events";
import type { SimpleView } from "./simpleView";
import { moonLight } from "./astronomy";
import { heatmap } from "./heatmap";
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
let lastAsk: TripAsk | null = null;      // re-planned after a clock jump (Demo: "Set to 2:15 AM")
let chosenTab: string | null = null;     // ...keeping the way the user started

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
    modes: a.modes ?? ["walk", "bus", "metro"], riskWeight: 1, maxWalkM: 2500 };
}

/** After the clock moves (or the night is reset), plan the same trip again for the new time. */
function replanAfterJump(): void {
  if (!lastAsk) { engine.replanner.tickAll(); return; }
  engine.endTrip();
  engine.plan(request(lastAsk));
  const o = chosenTab ? engine.view(lang)?.options.find((x) => x.id === chosenTab) : null;
  if (o) engine.choose(o.plan_id);
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
    return { city_name: m.city_name, center: m.center, radius_m: m.radius_m, zones: (m.zones ?? []).map((z) => ({ id: z.id, name: z.name, ring: z.ring })),
      bbox: engine.world.bbox(), tz_offset_min: m.tz_offset_min, night_hours: CONFIG.risk.nightHours, ui_defaults: m.ui_defaults, real: m.real, synthetic: m.synthetic, sample: m.sample };
  },
  setLang(l: Lang) { lang = l; push(true); },
  plan(a: TripAsk) { lastAsk = a; chosenTab = null; engine.plan(request(a)); const v = plainView(); lastView = JSON.stringify(v); return v; },
  view() { return plainView(); },
  choose(planId: string) {
    engine.choose(planId);
    const v = plainView();
    chosenTab = v?.options.find((o) => o.plan_id === planId)?.id ?? null;
    return v;
  },
  endTrip() { lastAsk = null; chosenTab = null; engine.endTrip(); push(true); },
  where(lat: number, lon: number) { return engine.world.nearestPlaceName(lat, lon); },
  inArea(lat: number, lon: number) { return engine.world.inArea(lat, lon); },
  areaHit(lat: number, lon: number) { return engine.world.areaHit(lat, lon); },
  geocode(q: string) { return engine.world.geocode(q); },
  needNow(type: string, lat: number, lon: number) { return engine.needNow(type, lat, lon, lang); },
  help(lat: number, lon: number) { return engine.help(lat, lon, lang); },
  roads,
  setOnline(on: boolean) { engine.setOnline(on); push(); },
  setRealWeather(current: Record<string, number | string | null>, observedAt: number) { engine.setRealWeather(current, observedAt); },
  setRealTraffic(pts: { lat: number; lon: number; f: number }[], observedAt: number) { return engine.setRealTraffic(pts, observedAt); },
  // ---- Demo drawer -----------------------------------------------------------------------------
  outage(source: SourceArg, enabled: boolean) { engine.outage(source, enabled); engine.replanner.tickAll(); push(); },
  inject(ev: SimEvent) { const r = engine.inject(ev); engine.replanner.tickAll(); push(); return r; },
  setClock(o: { time?: number; hhmm?: string; speed?: number; paused?: boolean }) {
    const time = o.hhmm ? engine.world.city.atNight(o.hhmm, engine.state.now()) : o.time;
    engine.setClock({ time, speed: o.speed, paused: o.paused });
    if (time !== undefined) replanAfterJump(); else engine.replanner.tickAll();
    push(true);
  },
  advance(seconds: number) { engine.advance(seconds); engine.replanner.tickAll(); push(true); },
  /** Demo: "Pretend night buses run (simulated)". Routes with unknown hours get assumed trips. */
  setPretend(on: boolean) { engine.state.pretendNightBuses = on; engine.state.logEvent("demo", on ? "pretend night buses: ON (simulated)" : "pretend night buses: off"); engine.replanner.tickAll(); push(true); },
  // ---- map layers (UPGRADE §3) ----------------------------------------------------------------------
  /** Streets marked lit (or lamps within 15 m) and marked dark in OpenStreetMap. Everything else: not sure. */
  litStreets() {
    const w = engine.world;
    const pack = (want: (e: number) => boolean) => {
      const pts: number[] = [], off: number[] = [0];
      for (let e = 0; e < w.m; e++) { if (!want(e)) continue; for (const c of w.egeom[e]) pts.push(c); off.push(pts.length); }
      return { pts: new Float32Array(pts), off: new Uint32Array(off), n: off.length - 1 };
    };
    const lit = pack((e) => w.lightSrc[e] === 0 && w.lightLo[e] < 0.5), dark = pack((e) => w.lightSrc[e] === 0 && w.lightLo[e] >= 0.5);
    let sat = 0, none = 0, tot = 0;
    for (let e = 0; e < w.m; e++) { tot += w.elen[e]; if (w.lightSrc[e] === 2) sat += w.elen[e]; if (w.lightSrc[e] === 3) none += w.elen[e]; }
    return { lit, dark, marked: lit.n + dark.n, satelliteShare: Math.round((sat / tot) * 1000) / 1000, unknownShare: Math.round((none / tot) * 1000) / 1000 };
  },
  /** Safety heat for an hour (default: the app clock's hour). */
  heat(hour?: number) {
    const h = hour ?? engine.world.city.hour(engine.state.now());
    return { hour: h, cells: heatmap(engine.world, h) };
  },
  /** Help places with their open state at the app clock (never "open" when the hours are not known). */
  helpPlaces(includeNotSure: boolean, openOnly: boolean) {
    const s = engine.state, layer = engine.cache.layer(s, s.now());
    const types = new Set(["hospital", "clinic", "police", "pharmacy", "fire_station", "fuel", "hotel"]);
    const out: { id: string; lat: number; lon: number; type: string; name: string; state: "open" | "maybe_open" | "not_sure" | "closed" }[] = [];
    for (const it of layer.pick((x) => types.has(x.p.type))) {
      const st = it.st === "UNKNOWN" || it.f.value === null ? "not_sure" : it.f.value === false ? "closed" : it.st === "KNOWN" ? "open" : "maybe_open";
      if (st === "not_sure" && !includeNotSure) continue;
      if (st === "closed" && openOnly) continue;
      out.push({ id: it.p.id, lat: it.p.lat, lon: it.p.lon, type: it.p.type === "clinic" ? "hospital" : it.p.type, name: it.p.name, state: st });
    }
    return out;
  },
  moon() { const c = engine.world.meta.zones?.[0]?.ring?.[0] ?? [engine.world.meta.center.lat, engine.world.meta.center.lon]; return moonLight(engine.state.now(), c[0], c[1]); },
  timing() { const c = engine.clock as AppClock; return { deadline: engine.active?.planset?.deadline ?? null, now: c.now(), speed: c.paused ? 0 : c.speed }; },
  clock() { const c = engine.clock as AppClock; return { now: c.now(), speed: c.speed, paused: c.paused, now_text: engine.world.city.clock(c.now()) ?? "", rain: engine.state.truth.rain, pretend: engine.state.pretendNightBuses }; },
  sources() { return Object.fromEntries(Object.entries(engine.state.sources).map(([k, v]) => [k, v.enabled])); },
  trust() { return engine.trust(); },
  details() { return engine.active?.planset ?? null; },
  log() { return engine.active?.log ?? []; },
  scenarios() { return SCENARIOS.map((s) => ({ id: s.id, name: s.name, description: s.description ?? "" })); },
  reset() { engine.reset(new AppClock(Date.now())); replanAfterJump(); push(true); },
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

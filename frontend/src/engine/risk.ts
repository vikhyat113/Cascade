// Risk scorer: per-edge risk intervals [lo, hi] for six components at a given time.
// Layout of lo/hi/code arrays: component c of edge e at index c * m + e.
import { COMPONENTS, CONFIG, SOURCES, type RiskComponent } from "../config";
import { CODE, STATUS_OF, type Fact, type FactView, type Status } from "./freshness";
import { OpenCache, type EdgeOpen } from "./services";
import type { State } from "./state";
import { clamp } from "./util";

export const CI: Record<RiskComponent, number> = { lighting: 0, incident: 1, isolation: 2, traffic: 3, weather: 4, emergency: 5 };
const RAIN_RISK: Record<string, number> = { none: 0.02, light: 0.3, moderate: 0.55, heavy: 0.85 };
const RAIN_WALK: Record<string, [number, number, number]> = { none: [1, 1, 1], light: [1, 0.97, 0.9], moderate: [0.98, 0.92, 0.82], heavy: [0.95, 0.85, 0.72] };
const RAIN_CAR: Record<string, number> = { none: 1, light: 0.92, moderate: 0.82, heavy: 0.68 };
const WIDEN = [0.25, 0.2, 0.1, 0.05];        // by status code: UNKNOWN, OUTDATED, PROBABLE, KNOWN

export interface Weather { rain: string | null; fog: boolean; lo: number; hi: number; code: number; view: FactView; walk: [number, number, number]; summary: string }
export interface CarTimes { free: Float64Array; lo: Float64Array; exp: Float64Array; hi: Float64Array; code: Uint8Array; conf: Float32Array }
export interface ClosureInfo { id: string; name: string; reason: string; kind: string; edges: number[]; lat: number; lon: number; status: Status }
export interface EdgeRisk { lo: Float32Array; hi: Float32Array; code: Uint8Array; walkBlocked: Uint8Array; carBlocked: Uint8Array; weather: Weather; open: EdgeOpen; closures: ClosureInfo[]; car: CarTimes }

export function rainClass(mm: number | null | undefined): string | null {
  if (mm == null) return null;
  return mm <= 0.05 ? "none" : mm < 2.5 ? "light" : mm < 7.6 ? "moderate" : "heavy";
}

export function isNight(hour: number): boolean { const [a, b] = CONFIG.risk.nightHours; return hour >= a || hour < b; }

export function forecastFact(s: State, t: number): Fact | null {
  const w = s.world;
  if (!s.available("weather_forecast") || w.weatherFetchedAt == null) return null;
  const row = w.weatherRows.get(w.city.hourKey(t));
  if (!row) return null;
  const c = SOURCES.weather_forecast;
  return { key: `weather:fc:${w.city.hourKey(t)}`, value: row, source: "weather_forecast", synthetic: false, observedAt: w.weatherFetchedAt, ttlS: c.ttlS, reliability: c.reliability, kind: "inferred", note: "Open-Meteo hourly forecast (saved)" };
}

export function assessWeather(s: State, t: number): Weather {
  const now = s.now();
  const live = s.get("weather:now") ?? null;
  const liveSt = s.statusOf(live);
  const fc = forecastFact(s, t);
  const fcSt = s.statusOf(fc);
  const near = Math.abs(t - now) <= 45 * 60000;
  let f: Fact | null = null, st: Status = "UNKNOWN";
  if ((liveSt === "KNOWN" || liveSt === "PROBABLE") && near) { f = live; st = liveSt; }
  else if (fcSt !== "UNKNOWN") { f = fc; st = fcSt; }
  else if (liveSt === "OUTDATED") { f = live; st = liveSt; }
  if (!f || st === "UNKNOWN") {
    return { rain: null, fog: false, lo: 0, hi: 0.7, code: CODE.UNKNOWN, walk: [1, 0.95, 0.8], summary: "weather unknown",
      view: s.view(f, { key: "weather", interval: [0, 0.7], source: "weather", note: "no usable weather: assuming anything from dry to heavy rain" }) };
  }
  const v = (f.value ?? {}) as Record<string, number | string | boolean | null>;
  const mm = (v.rain ?? v.rain_mm ?? v.precipitation ?? v.precip_mm) as number | null;
  const rc = (v.rain_class as string) || rainClass(mm) || "none";
  const vis = v.visibility as number | null;
  const fog = Boolean(v.fog) || (vis != null && vis < 1000);
  const wind = (v.wind_speed_10m ?? v.wind_kmh ?? 0) as number;
  const base = RAIN_RISK[rc] + (fog ? 0.25 : 0) + (wind > 40 ? 0.1 : 0);
  const p = ((v.precipitation_probability ?? v.precip_prob ?? 0) as number) / 100;
  let lo: number, hi: number;
  if (st === "KNOWN") { lo = base - 0.05; hi = base + 0.05; }
  else if (st === "PROBABLE") { lo = base - 0.1; hi = base + 0.15 + 0.4 * p; }
  else { lo = base - 0.2; hi = base + 0.45; }
  lo = clamp(lo, 0, 1); hi = clamp(hi, 0, 1);
  let walk = RAIN_WALK[rc];
  if (st === "OUTDATED") walk = [walk[0], walk[1] * 0.97, walk[2] * 0.9];
  return { rain: rc, fog, lo, hi, code: CODE[st], walk, summary: (rc !== "none" ? `${rc} rain` : "dry") + (fog ? ", fog" : ""),
    view: s.view(f, { interval: [Math.round(lo * 1000) / 1000, Math.round(hi * 1000) / 1000] }) };
}

/** Speed factor / status / confidence per traffic cell, memoised per sim instant. */
function trafficCells(s: State): Map<number, [number, number, number]> {
  const memo = (s as unknown as { _tmemo?: { t: number; v: number; m: Map<number, [number, number, number]> } });
  const now = s.now();
  if (memo._tmemo && memo._tmemo.t === now && memo._tmemo.v === s.version) return memo._tmemo.m;
  const out = new Map<number, [number, number, number]>();
  for (const c of s.world.trafficCells) {
    const f = s.get(`traffic:cell:${c}`);
    const st = s.statusOf(f);
    out.set(c, [st === "UNKNOWN" ? NaN : ((f!.value as { speed_factor: number }).speed_factor), CODE[st], st === "UNKNOWN" ? 0 : s.confOf(f)]);
  }
  memo._tmemo = { t: now, v: s.version, m: out };
  return out;
}

export function carTimes(s: State): CarTimes {
  const w = s.world, m = w.m;
  const cells = trafficCells(s);
  const rain = s.get("weather:now");
  const rc = s.statusOf(rain) !== "UNKNOWN" ? ((rain!.value as { rain_class?: string }).rain_class ?? "none") : "none";
  const t: CarTimes = { free: w.ttFree, lo: new Float64Array(m), exp: new Float64Array(m), hi: new Float64Array(m), code: new Uint8Array(m), conf: new Float32Array(m) };
  for (let e = 0; e < m; e++) {
    const [fac, code, conf] = cells.get(w.tcell[e]) ?? [NaN, 0, 0];
    const free = w.ttFree[e] / (RAIN_CAR[rc] ?? 1);
    const base = free / (isFinite(fac) ? Math.max(0.1, fac) : 1);
    t.code[e] = code; t.conf[e] = conf;
    if (code === CODE.KNOWN) { t.lo[e] = base * 0.92; t.exp[e] = base; t.hi[e] = base * 1.12; }
    else if (code === CODE.PROBABLE) { t.lo[e] = base * 0.85; t.exp[e] = base; t.hi[e] = base * 1.3; }
    else if (code === CODE.OUTDATED) { t.lo[e] = free; t.exp[e] = base * 1.1; t.hi[e] = base * 1.7; }
    else { t.lo[e] = free; t.hi[e] = free * 2; t.exp[e] = (t.lo[e] + t.hi[e]) / 2; }   // interval midpoint, not an invented reading
  }
  return t;
}

export function activeClosures(s: State): ClosureInfo[] {
  return s.withPrefix("closure:").filter((f) => (f.value as { active?: boolean })?.active).map((f) => {
    const v = f.value as { name: string; reason: string; kind: string; edges: number[]; lat: number; lon: number };
    return { id: f.key.slice(8), name: v.name, reason: v.reason, kind: v.kind, edges: v.edges, lat: v.lat, lon: v.lon, status: s.statusOf(f) };
  });
}

export function edgeRisk(s: State, t: number, cache: OpenCache): EdgeRisk {
  const w = s.world, m = w.m;
  const lo = new Float32Array(6 * m), hi = new Float32Array(6 * m), code = new Uint8Array(6 * m);
  const dark = isNight(w.city.hour(t)) ? 1 : 0.25;
  const L = CI.lighting * m;
  for (let e = 0; e < m; e++) { lo[L + e] = w.lightLo[e] * dark; hi[L + e] = w.lightHi[e] * dark; code[L + e] = w.lightCode[e]; }

  // incident history (synthetic) for this hour
  const I = CI.incident * m;
  const hs = s.statusOf(s.heartbeat("incident_history"));
  const risk = w.incRisk.get(w.city.hour(t));
  for (let e = 0; e < m; e++) {
    if (hs !== "UNKNOWN" && risk) { const v = risk[w.cell[e]] ?? 0; lo[I + e] = 0.8 * v; hi[I + e] = Math.min(1, 1.2 * v + 0.05); code[I + e] = CODE[hs]; }
    else { lo[I + e] = 0; hi[I + e] = 0.8; code[I + e] = CODE.UNKNOWN; }
  }

  // isolation + emergency from open places
  const open = cache.edgesAt(s, t);
  const S = CI.isolation * m, M = CI.emergency * m;
  lo.set(open.isoLo, S); hi.set(open.isoHi, S); code.set(open.isoCode, S);
  lo.set(open.emLo, M); hi.set(open.emHi, M); code.set(open.emCode, M);

  // traffic exposure (pedestrian) + closures
  const T = CI.traffic * m;
  const cells = trafficCells(s);
  for (let e = 0; e < m; e++) {
    const [fac, c] = cells.get(w.tcell[e]) ?? [NaN, CODE.UNKNOWN, 0];
    lo[T + e] = w.walkTraffic[e];
    hi[T + e] = w.walkTraffic[e] + WIDEN[c];
    if (isFinite(fac) && fac < 0.6) { lo[T + e] += 0.2; hi[T + e] += 0.3; }       // accident nearby
    code[T + e] = c === CODE.KNOWN ? CODE.PROBABLE : c;                             // class-based exposure is inferred
  }
  const walkBlocked = new Uint8Array(m), carBlocked = new Uint8Array(m);
  const closures = activeClosures(s);
  for (const c of closures) {
    for (const e of c.edges) {
      if (c.status === "UNKNOWN") { hi[T + e] += 0.3; continue; }                 // too old to trust: widen, do not block
      if (w.carOk[e]) carBlocked[e] = 1;                                           // barricades stop vehicles
      if (c.kind === "waterlogging") walkBlocked[e] = 1;                           // floods stop everyone
      else { lo[T + e] += 0.2; hi[T + e] += 0.35; }                                // walkers pass, but it is unpleasant
    }
  }

  // weather (same for every outdoor edge)
  const wx = assessWeather(s, t);
  const W = CI.weather * m;
  for (let e = 0; e < m; e++) { lo[W + e] = wx.lo; hi[W + e] = wx.hi; code[W + e] = wx.code; }
  if (wx.rain === "moderate" || wx.rain === "heavy") for (const e of w.floodEdges) hi[W + e] += 0.15;

  for (let i = 0; i < 6 * m; i++) { lo[i] = clamp(lo[i], 0, 1); hi[i] = Math.max(lo[i], clamp(hi[i], 0, 1)); }
  return { lo, hi, code, walkBlocked, carBlocked, weather: wx, open, closures, car: carTimes(s) };
}

export interface Comps { [c: string]: { lo: number; hi: number; w: Record<Status, number> } }

/** Length-weighted risk per component over a set of edges, plus status shares by length. */
export function pathComps(er: EdgeRisk, idx: number[], len: Float64Array, factor: Partial<Record<RiskComponent, number>> = {}, m = len.length): Comps {
  const out: Comps = {};
  const total = idx.reduce((a, e) => a + len[e], 0) || 1;
  for (const c of COMPONENTS) {
    const k = CI[c] * m, f = factor[c] ?? 1;
    let a = 0, b = 0;
    const w: Record<Status, number> = { UNKNOWN: 0, OUTDATED: 0, PROBABLE: 0, KNOWN: 0 };
    for (const e of idx) { a += er.lo[k + e] * len[e]; b += er.hi[k + e] * len[e]; w[STATUS_OF[er.code[k + e]]] += len[e]; }
    out[c] = { lo: (a / total) * f, hi: (b / total) * f, w };
  }
  return out;
}

export function combine(comp: Comps): [number, number] {
  const W = CONFIG.risk.weights;
  const tot = COMPONENTS.reduce((a, c) => a + W[c], 0);
  return [COMPONENTS.reduce((a, c) => a + W[c] * comp[c].lo, 0) / tot, COMPONENTS.reduce((a, c) => a + W[c] * comp[c].hi, 0) / tot];
}

/** Uncertainty-averse per-edge risk used inside path costs. */
export function edgeCostRisk(er: EdgeRisk, m: number): Float64Array {
  const W = CONFIG.risk.weights;
  const tot = COMPONENTS.reduce((a, c) => a + W[c], 0);
  const out = new Float64Array(m);
  for (const c of COMPONENTS) {
    const k = CI[c] * m, wt = W[c] / tot;
    for (let e = 0; e < m; e++) out[e] += wt * (er.lo[k + e] + 0.6 * (er.hi[k + e] - er.lo[k + e]));
  }
  return out;
}

export { OpenCache };

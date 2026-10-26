// Planner (spec §7.3): candidates -> forward-in-time evaluation -> robust selection.
// Times propagate as [best, expected, worst] seconds after departure (Infinity = not possible
// in that case). Risks are intervals. The planner only reads Facts, never simulator truth.
import { COMPONENTS, CONFIG, type RiskComponent } from "../config";
import { RANK, STATUS_OF, coverageStatus, shares, weakest, type FactView, type Status } from "./freshness";
import { CI, combine, edgeCostRisk, edgeRisk, pathComps, type Comps, type EdgeRisk } from "./risk";
import { havensNear, poiView, type OpenCache, type PoiView } from "./services";
import type { State } from "./state";
import { compareWays, computeEdgeCost, diverseWays, type CandidateMetrics, type RGraph } from "./kshortest";
import { itineraries, nextDeparture, tripTiming, tripsAfter, type TripTiming } from "./transit";
import { shortestPath, type Route, type World } from "./world";

const P = CONFIG.planner;
const CASES = ["best", "expected", "worst"] as const;
type Tri = [number, number, number];
export type Mode = "walk" | "bus" | "metro";

export interface Point { lat: number; lon: number; name?: string; kind?: "home" | "work" | null }
export interface PlanRequest { origin: Point; destination: Point; start?: number | null; deadline?: number | null; modes?: Mode[]; riskWeight?: number; maxWalkM?: number }

export interface Leg { mode: Mode; edges: [number, boolean][]; a: [number, number, string]; b: [number, number, string]; connectorM: number; routeId?: string; dir?: "A" | "B"; board?: number; alight?: number }
export interface RouteSpec { kind: Mode; legs: Leg[]; lam: number; sig: string }

export interface Category { name: string; label: string; status: Status; confidence: number; detail: string; critical: boolean; w?: Record<Status, number> }
export interface Segment {
  mode: "walk" | "wait" | "bus" | "metro"; label: string; from: string; to: string;
  start: Record<string, number | null>; end: Record<string, number | null>; durationS: Record<string, number | null>;
  distanceM: number; coords: [number, number][]; risk: Record<string, { lo: number; hi: number }>; safety: { lo: number; hi: number };
  status: Status; facts: FactView[]; tripId?: string; routeId?: string; haven?: string | null; change?: boolean;
}
export interface Plan {
  id: string; kind: Mode; lam: number; labels: string[]; modes: string[]; title: string;
  eta: Record<string, number | null>; durationMin: Record<string, number | null>; feasible: Record<string, boolean>;
  safety: { lo: number; hi: number }; risk: Record<string, { lo: number; hi: number }>;
  trust: { status: Status; confidence: number; limiting: string | null; overall: Status; categories: Category[] };
  segments: Segment[]; distanceM: number; walkM: number; outdoorMin: number; warnings: string[];
  safeHavens: PoiView[]; openAlong: PoiView[]; dependsOn: string[]; explanation: string; leaveAdvice: string | null;
}
export interface PlanB { planId: string; weakLink: string; weakStatus: Status; reason: string; trigger: string }
export interface PlanSet {
  id?: string; phase: "before_departure" | "in_progress" | "arrived"; computedAt: number; departure: number; deadline: number | null;
  plans: Plan[]; recommendedId: string | null; planB: PlanB | null; feasibilityLevel: string; noFeasible: boolean;
  warnings: string[]; notes: string[]; weather: FactView; closures: { id: string; name: string; reason: string; kind: string; lat: number; lon: number; status: Status }[];
  havensNearOrigin: PoiView[]; pinnedInvalid: string | null; userLocked?: boolean; changeLog?: LogEntry[]; history?: { t: number; confidence: number; safetyLo: number }[];
  compare?: ReturnType<typeof compareWays>;        // "Other ways" ranking (U3)
}

/** The world's street graph as the multi-route engine sees it. */
export function worldGraph(w: World): RGraph {
  return { m: w.m, elen: w.elen, nx: w.nx, ny: w.ny, emx: w.emx, emy: w.emy,
    adj: (u: number) => { const out: [number, number, boolean][] = []; for (let k = w.adjStart[u]; k < w.adjStart[u + 1]; k++) { const e = w.adjEdge[k]; out.push([w.adjNode[k], e, w.eu[e] !== u]); } return out; } };
}
export interface LogEntry { t: number; hhmm: string; kind: string; severity: "info" | "warn" | "alert"; message: string; code: string; detail?: string; critical?: boolean }

export const CATEGORY_LABEL: Record<string, string> = {
  lighting: "Street lighting", incidents: "Incident data", isolation: "Open places nearby", emergency: "Emergency access",
  weather: "Weather", traffic: "Traffic speeds", closures: "Road closures", transit_timing: "Bus / metro timing",
};
const CRITICAL: Record<Mode, string[]> = { walk: ["closures", "weather"], bus: ["transit_timing", "closures"], metro: ["transit_timing", "closures"] };
const STATUS_CONF = [0, 0.2, 0.45, 0.75];

function sig(kind: Mode, legs: Leg[]): string {
  let h = 2166136261;
  const s = legs.map((l) => `${l.mode}|${l.routeId ?? ""}|${l.board ?? ""}|${l.alight ?? ""}|${l.edges.map((e) => e[0]).join(",")}`).join(";");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${kind}-${(h >>> 0).toString(16)}`;
}
const mk = (kind: Mode, legs: Leg[], lam: number): RouteSpec => ({ kind, legs, lam, sig: sig(kind, legs) });
const ptOf = (p: Point): [number, number, string] => [p.lat, p.lon, p.name ?? ""];
const fmtM = (d: number) => (d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 10) * 10} m`);

/** Aggregate view of a category (UNKNOWN never carries a value). */
function mkView(key: string, value: unknown, st: Status, conf: number, source: string, synthetic: boolean, note: string | null, interval: [number, number] | null = null): FactView {
  return { key, value: st === "UNKNOWN" ? null : value, status: st, confidence: st === "UNKNOWN" ? 0 : Math.round(conf * 1000) / 1000, source, ageS: null, synthetic, kind: null, note, interval };
}

class Ctx {
  w: World; t0: number; deadline: number | null = null; notes: string[] = []; warnings: string[] = [];
  private er = new Map<number, EdgeRisk>();
  constructor(public s: State, public req: PlanRequest, public cache: OpenCache, departure: number) { this.w = s.world; this.t0 = departure; }
  riskAt(t: number): EdgeRisk {
    const k = Math.floor(t / 900000);
    let r = this.er.get(k);
    if (!r) { r = edgeRisk(this.s, k * 900000, this.cache); this.er.set(k, r); }
    return r;
  }
  at(off: number): number { return this.t0 + (isFinite(off) ? off * 1000 : 0); }
}

// ---- candidates -----------------------------------------------------------------------------------------
function overlap(a: RouteSpec, b: RouteSpec, w: World): number {
  const es = (r: RouteSpec) => { const m = new Map<number, number>(); for (const l of r.legs) for (const [e] of l.edges) m.set(e, w.elen[e]); return m; };
  const ea = es(a), eb = es(b);
  if (!ea.size || !eb.size) return !ea.size && !eb.size && a.kind === b.kind ? 1 : 0;
  let shared = 0, ta = 0, tb = 0;
  for (const [e, l] of ea) { ta += l; if (eb.has(e)) shared += l; }
  for (const [, l] of eb) tb += l;
  return shared / Math.max(ta, tb);
}

/** Walking candidates only change with the risk picture (15-min slice) or blocked streets, so the
 *  re-planner (every tick) reuses them: λ searches + diverse ways are the costly part of planning. */
const walkCache = new WeakMap<State, Map<string, RouteSpec[]>>();

function walkCandidates(c: Ctx): RouteSpec[] {
  const w = c.w, m = w.m;
  const [o, od] = w.nearestNode(c.req.origin.lat, c.req.origin.lon);
  const [d, dd] = w.nearestNode(c.req.destination.lat, c.req.destination.lon);
  const er = c.riskAt(c.t0);
  let blockedSig = 0;
  for (let e = 0; e < m; e++) if (er.walkBlocked[e]) blockedSig = (blockedSig * 31 + e) % 1000000007;
  const key = `${o}|${d}|${Math.floor(c.t0 / 900000)}|${blockedSig}|${c.req.origin.lat},${c.req.origin.lon}|${c.req.destination.lat},${c.req.destination.lon}`;
  let byState = walkCache.get(c.s);
  if (!byState) { byState = new Map(); walkCache.set(c.s, byState); }
  const hit = byState.get(key);
  if (hit) return hit;
  const out = walkSearch(c, o, od, d, dd, er);
  if (byState.size > 20) byState.clear();
  byState.set(key, out);
  return out;
}

function walkSearch(c: Ctx, o: number, od: number, d: number, dd: number, er: EdgeRisk): RouteSpec[] {
  const w = c.w, m = w.m;
  const risk = edgeCostRisk(er, m);
  const out: RouteSpec[] = [];
  const cost = new Float64Array(m);
  let ref: [number, boolean][] | null = null;
  for (const lam of P.lambdas) {
    for (let e = 0; e < m; e++) cost[e] = w.elen[e] / P.walkSpeed.expected + lam * P.riskCostSPerM * w.elen[e] * risk[e];
    const path = shortestPath(w, o, d, cost, { blocked: er.walkBlocked });
    if (!path) continue;
    if (lam === 1) ref = path;
    out.push(mk("walk", [{ mode: "walk", edges: path, a: ptOf(c.req.origin), b: ptOf(c.req.destination), connectorM: od + dd }], lam));
  }
  // diverse alternatives: Yen's K-shortest loopless paths on the safety-aware cost (U3), walkable trips only
  const straight = Math.hypot(w.nx[o] - w.nx[d], w.ny[o] - w.ny[d]);
  if (straight <= P.yen.maxStraightM) {
    const W = COMPONENTS.map((k) => CONFIG.risk.weights[k]);
    const ycost = computeEdgeCost(w, (c, e) => er.lo[c * m + e], (c, e) => er.hi[c * m + e], W, er.walkBlocked,
      { walkFactor: er.weather.walk[1], speed: P.walkSpeed.expected, lam: 1, u: 0.5 });
    const y = diverseWays(worldGraph(w), o, d, ycost, er.walkBlocked, { maxK: P.yen.maxK, timeBudgetMs: P.yen.budgetMs, corridorM: P.yen.corridorM, diverseN: P.yen.k });
    for (const p of y.kept.slice(1))
      out.push(mk("walk", [{ mode: "walk", edges: p.edges, a: ptOf(c.req.origin), b: ptOf(c.req.destination), connectorM: od + dd }], 1));
  }
  if (ref) {                                                     // one diversified alternative
    const pen = new Set(ref.map(([e]) => e));
    for (let e = 0; e < m; e++) cost[e] = (w.elen[e] / P.walkSpeed.expected + P.riskCostSPerM * w.elen[e] * risk[e]) * (pen.has(e) ? 1.6 : 1);
    const path = shortestPath(w, o, d, cost, { blocked: er.walkBlocked });
    if (path) out.push(mk("walk", [{ mode: "walk", edges: path, a: ptOf(c.req.origin), b: ptOf(c.req.destination), connectorM: od + dd }], 1));
  }
  return out;
}

/** Bus / metro ways with up to CONFIG.transit.maxTransfers changes (itinerary search in transit.ts),
 *  turned into legs: walk -> ride -> (walk to change) -> ride ... -> walk. */
function transitCandidates(c: Ctx, modes: Set<string>): RouteSpec[] {
  const w = c.w, m = w.m;
  const from = { x: w.proj.x(c.req.origin.lon), y: w.proj.y(c.req.origin.lat) };
  const to = { x: w.proj.x(c.req.destination.lon), y: w.proj.y(c.req.destination.lat) };
  const its = itineraries(w, from, to, { modes, accessM: P.maxAccessWalkM, walkMps: P.walkSpeed.expected });
  if (!its.length) return [];
  const er = c.riskAt(c.t0);
  const risk = edgeCostRisk(er, m);
  const cost = new Float64Array(m);
  for (let e = 0; e < m; e++) cost[e] = w.elen[e] / P.walkSpeed.expected + P.riskCostSPerM * w.elen[e] * risk[e];
  const walk = (fromN: number, fromC: number, a: Leg["a"], toN: number, toC: number, b: Leg["b"]): Leg | null => {
    const path = fromN === toN ? [] : shortestPath(w, fromN, toN, cost, { blocked: er.walkBlocked });
    return path ? { mode: "walk", edges: path, a, b, connectorM: fromC + toC } : null;
  };
  const out: RouteSpec[] = [];
  for (const it of its) {
    const legs: Leg[] = [];
    let [node, conn] = w.nearestNode(c.req.origin.lat, c.req.origin.lon);
    let pt = ptOf(c.req.origin), ok = true;
    for (const ride of it.rides) {
      const route = w.routes.get(ride.routeId)!;
      const sb = route.stops[ride.board], sa = route.stops[ride.alight];
      const [nb, nbd] = w.nearestNode(sb.lat, sb.lon);
      const wl = walk(node, conn, pt, nb, nbd, [sb.lat, sb.lon, sb.name]);
      if (!wl) { ok = false; break; }
      legs.push(wl, { mode: route.mode as Mode, edges: [], a: [sb.lat, sb.lon, sb.name], b: [sa.lat, sa.lon, sa.name], connectorM: 0,
        routeId: route.id, dir: ride.dir, board: ride.board, alight: ride.alight });
      [node, conn] = w.nearestNode(sa.lat, sa.lon);
      pt = [sa.lat, sa.lon, sa.name];
    }
    const [d, dd] = w.nearestNode(c.req.destination.lat, c.req.destination.lon);
    const last = ok ? walk(node, conn, pt, d, dd, ptOf(c.req.destination)) : null;
    if (!last) continue;
    legs.push(last);
    const kind: Mode = it.rides.some((r) => w.routes.get(r.routeId)!.mode === "bus") ? "bus" : "metro";
    out.push(mk(kind, legs, it.transfers));
  }
  return out;
}

// ---- evaluation -------------------------------------------------------------------------------------------
class Eval {
  cur: Tri = [0, 0, 0];
  segments: Segment[] = [];
  parts: [number, "outdoor" | "vehicle" | "haven", Comps][] = [];
  cats = new Map<string, Category>();
  walkM = 0; distM = 0; invalid: string | null = null; warn: string[] = [];
  usesUnknownHours = false;        // depends on a route whose hours are not known
  timing: TripTiming | null = null; havens: PoiView[] = []; along = new Map<string, PoiView>();
  constructor(public c: Ctx, public spec: RouteSpec) {}

  times(off: Tri) { return Object.fromEntries(CASES.map((k, i) => [k, isFinite(off[i]) ? this.c.at(off[i]) : null])); }

  cat(name: string, st: Status, conf: number, detail: string) {
    const prev = this.cats.get(name);
    if (!prev || RANK[st] < RANK[prev.status] || (st === prev.status && conf < prev.confidence))
      this.cats.set(name, { name, label: CATEGORY_LABEL[name], status: st, confidence: Math.round(conf * 1000) / 1000, detail, critical: false });
  }
  coverage(name: string, wts: Record<Status, number>, conf: number, detail: string) {
    if (Object.values(wts).reduce((a, b) => a + b, 0) <= 0) return;
    const prev = this.cats.get(name);
    if (prev?.w) { for (const k of Object.keys(wts) as Status[]) wts[k] += prev.w[k]; conf = (conf + prev.confidence) / 2; }
    this.cats.set(name, { name, label: CATEGORY_LABEL[name], status: coverageStatus(wts), confidence: Math.round(conf * 1000) / 1000, detail, critical: false, w: wts });
  }

  pointComps(er: EdgeRisk, lat: number, lon: number): Comps {
    const e = this.c.w.nearestEdge(lat, lon);
    return pathComps(er, [e], this.c.w.elen);
  }

  seg(mode: Segment["mode"], label: string, leg: Leg, start: Tri, end: Tri, dist: number, coords: [number, number][], comps: Comps, facts: FactView[]): Segment {
    const [lo, hi] = combine(comps);
    return { mode, label, from: leg.a[2], to: leg.b[2], start: this.times(start), end: this.times(end),
      durationS: Object.fromEntries(CASES.map((k, i) => [k, isFinite(end[i]) && isFinite(start[i]) ? Math.round(end[i] - start[i]) : null])),
      distanceM: Math.round(dist), coords, risk: Object.fromEntries(COMPONENTS.map((k) => [k, { lo: Math.round(comps[k].lo * 1000) / 1000, hi: Math.round(comps[k].hi * 1000) / 1000 }])),
      safety: { lo: Math.round(100 * (1 - hi)), hi: Math.round(100 * (1 - lo)) }, status: facts.length ? weakest(facts.map((f) => f.status)) : "PROBABLE", facts };
  }

  walk(leg: Leg) {
    const { c } = this, w = c.w;
    const er = c.riskAt(c.at(this.cur[1]));
    const idx = leg.edges.map(([e]) => e);
    if (idx.some((e) => er.walkBlocked[e])) {
      const blocked = idx.filter((e) => er.walkBlocked[e]);
      const why = er.closures.some((cl) => cl.kind === "closure" && cl.edges.some((e) => blocked.includes(e))) ? "closure" : "flooded street";
      this.invalid = `way crosses a ${why} (${[...new Set(blocked.map((e) => w.ename[e] || "a street"))].join(", ")})`; return;
    }
    const dist = idx.reduce((a, e) => a + w.elen[e], 0) + leg.connectorM;
    const wf = er.weather.walk;
    const dur: Tri = [dist / (P.walkSpeed.best * wf[0]), dist / (P.walkSpeed.expected * wf[1]), dist / (P.walkSpeed.worst * wf[2])];
    const comps = idx.length ? pathComps(er, idx, w.elen) : this.pointComps(er, leg.a[0], leg.a[1]);
    const start = [...this.cur] as Tri;
    this.cur = this.cur.map((v, i) => v + dur[i]) as Tri;
    this.walkM += dist; this.distM += dist;
    this.parts.push([dur[1], "outdoor", comps]);
    const coords: [number, number][] = [[leg.a[0], leg.a[1]], ...w.pathCoords(leg.edges), [leg.b[0], leg.b[1]]];
    const facts: FactView[] = [];
    if (idx.length) {
      const L = idx.map((e) => w.elen[e]), tot = L.reduce((a, b) => a + b, 0) || 1;
      const lw = comps.lighting.w;
      const sh = shares(lw);
      const conf = idx.reduce((a, e, i) => a + w.lightConf[e] * L[i], 0) / tot;
      const bySrc = [0, 0, 0, 0];
      idx.forEach((e, i) => { bySrc[w.lightSrc[e]] += L[i]; });
      const pc = (k: number) => Math.round((bySrc[k] / tot) * 100);
      const src = `${pc(0)}% mapped, ${pc(1)}% main roads, ${pc(2)}% satellite`;
      facts.push(mkView("lighting:segment", src, coverageStatus(lw), conf, "osm_map", false,
        `${Math.round(sh.UNKNOWN * 100)}% of this stretch has no lighting data`, [Math.round(comps.lighting.lo * 100) / 100, Math.round(comps.lighting.hi * 100) / 100]));
      this.coverage("lighting", { ...lw }, conf, `${src}, ${Math.round(sh.UNKNOWN * 100)}% no data`);
      const iconf = (Object.entries(comps.isolation.w) as [Status, number][]).reduce((a, [k, v]) => a + STATUS_CONF[RANK[k]] * v, 0) / tot;
      this.coverage("isolation", { ...comps.isolation.w }, iconf, "open-state of places along the way");
      const hs = c.s.sourceView("incident_history");
      this.cat("incidents", hs.status, hs.confidence, `history ${hs.status} (synthetic)`);
      let k = idx[0];
      for (const e of idx) if (er.open.emDist[e] < er.open.emDist[k]) k = e;
      const it = er.open.emItem[k];
      const code = er.open.emCode[k];
      this.cat("emergency", STATUS_OF[code], STATUS_CONF[code], er.open.emDist[k] < 3000 ? `nearest open hospital/police ${fmtM(er.open.emDist[k])} from the way` : "none confirmed open within 3 km");
      facts.push(it && er.open.emDist[k] < 3000
        ? mkView("emergency:nearest", `${it.p.name || it.p.type} (${fmtM(er.open.emDist[k])})`, it.st, c.s.confOf(it.f), it.f.source, false, it.f.note ?? null)
        : mkView("emergency:nearest", null, "UNKNOWN", 0, "osm_hours", false, "no hospital / police confirmed open within 3 km"));
      this.openAlong(idx, c.at(start[1]));
    }
    facts.push(er.weather.view);
    this.cat("weather", er.weather.view.status, er.weather.view.confidence, er.weather.summary);
    const named = new Map<string, number>();
    for (const e of idx) if (w.ename[e]) named.set(w.ename[e]!, (named.get(w.ename[e]!) ?? 0) + w.elen[e]);
    const via = [...named.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n]) => n);
    this.segments.push(this.seg("walk", `Walk ${fmtM(dist)}${via.length ? ` via ${via.join(", ")}` : ""}`, leg, start, this.cur, dist, coords, comps, facts));
  }

  openAlong(idx: number[], t: number) {
    const { c } = this, w = c.w;
    const layer = c.cache.layer(c.s, t);
    const good = layer.pick((it) => it.f.value === true && (it.st === "KNOWN" || it.st === "PROBABLE") && it.p.type !== "atm");
    for (const e of idx) for (const it of good) {
      if (this.along.has(it.p.id)) continue;
      const d = Math.hypot(it.p.x - w.emx[e], it.p.y - w.emy[e]);
      if (d <= 80) this.along.set(it.p.id, poiView(c.s, it.p, t, d));
    }
  }

  /** Waiting at a stop: inside a safe place near it when the wait is long. Returns the risk parts. */
  waitPlace(stop: Route["stops"][number], waitS: number) {
    const { c } = this;
    const haven = waitS > 240 ? havensNear(c.s, c.cache, c.at(this.cur[1]), stop.x, stop.y, P.safeHavenRadiusM, 1) : [];
    let wcomps = this.pointComps(c.riskAt(c.at(this.cur[1])), stop.lat, stop.lon);
    if (haven.length) {
      const hw = CONFIG.risk.safeHavenWaitRisk;
      wcomps = Object.fromEntries(Object.entries(wcomps).map(([k, v]) => [k, { lo: Math.min(v.lo, hw), hi: Math.min(v.hi, hw * 2), w: v.w }]));
      this.havens.push(...haven);
    }
    return { haven, wcomps };
  }

  rideParts(route: Route, leg: Leg) {
    const { c } = this;
    const stop = route.stops[leg.board!];
    const rf = CONFIG.risk.transitRideFactor;
    const pc = this.pointComps(c.riskAt(c.at(this.cur[1])), stop.lat, stop.lon);
    const comps: Comps = Object.fromEntries(Object.entries(pc).map(([k, v]) => [k, { lo: v.lo * (k === "weather" ? 0 : rf), hi: v.hi * (k === "weather" ? 0 : rf), w: v.w }]));
    const [lo, hi] = [Math.min(leg.board!, leg.alight!), Math.max(leg.board!, leg.alight!)];
    const rideS = route.segS.slice(lo, hi).reduce((a, b) => a + b, 0);
    const rideM = rideS * (route.mode === "bus" ? P.busSpeedMps : 11);
    const stops = route.stops.slice(lo, hi + 1);
    const coords = (leg.alight! > leg.board! ? stops : [...stops].reverse()).map((x) => [x.lat, x.lon] as [number, number]);
    return { comps, rideS, rideM, coords };
  }

  /** A route whose service hours are not known: never invented. The wait has no worst case (it may not run
   *  at all), the timing is UNKNOWN, and the plan says so in plain words with a Backup. */
  unknownService(leg: Leg, route: Route) {
    const { c } = this, w = c.w;
    const hw = (route.headwayMin ?? CONFIG.transit.unknownHeadwayMin) * 60;
    const stop = route.stops[leg.board!];
    const view = mkView(`transit:hours:${route.id}`, null, "UNKNOWN", 0, "transit_schedule", route.synthetic, `${route.name}: service hours not known${route.synthetic ? "; bus times are estimated" : ""}`);
    const change = this.segments.some((x) => x.mode === "bus" || x.mode === "metro");
    const start = [...this.cur] as Tri;
    const waitEnd: Tri = [start[0] + 60, start[1] + hw / 2, Infinity];
    const { haven, wcomps } = this.waitPlace(stop, hw / 2);
    this.parts.push([hw / 2, haven.length ? "haven" : "outdoor", wcomps]);
    const where = haven.length ? `at ${haven[0].name} (${haven[0].distM} m from the stop)` : `at ${stop.name}`;
    const wseg = this.seg("wait", `Wait ${where} for ${route.id}: hours not known (about every ${Math.round(hw / 60)} min)`, leg, start, waitEnd, 0, [[stop.lat, stop.lon]], wcomps, [view]);
    Object.assign(wseg, { routeId: route.id, haven: haven[0]?.name ?? null, change });
    this.segments.push(wseg);
    this.cur = waitEnd;
    const { comps, rideS, rideM, coords } = this.rideParts(route, leg);
    const s0 = [...this.cur] as Tri;
    this.cur = [s0[0] + rideS * 0.9, s0[1] + rideS, Infinity];
    this.distM += rideM;
    this.parts.push([rideS, "vehicle", comps]);
    const rseg = this.seg(route.mode as Segment["mode"], `${route.id} ${route.stops[leg.board!].name} -> ${route.stops[leg.alight!].name}`, leg, s0, this.cur, rideM, coords, comps, [view]);
    Object.assign(rseg, { routeId: route.id });
    this.segments.push(rseg);
    this.usesUnknownHours = true;
    this.cat("transit_timing", "UNKNOWN", 0, `${route.id}: service hours not known${route.synthetic ? " (estimated route)" : ""}`);
    this.warn.push(`${route.id}: not sure it runs now (service hours not known)`);
    void w;
  }

  transit(leg: Leg) {
    const { c } = this, w = c.w, s = c.s;
    const route = w.routes.get(leg.routeId!)!;
    const pretend = s.pretendNightBuses;
    if (!route.hoursKnown && !pretend) { this.unknownService(leg, route); return; }
    const arr = this.cur.map((o) => (isFinite(o) ? c.at(o) : null));
    const trips = tripsAfter(w, route, leg.dir!, leg.board!, arr[0] ?? c.t0, 8, pretend);
    const timings = trips.map((tr) => tripTiming(s, tr, leg.board!, leg.alight!)).filter((x): x is TripTiming => !!x);
    if (!timings.length) {
      const nxt = nextDeparture(w, route.id, arr[1] ?? c.t0, pretend);
      this.invalid = s.available("transit_schedule") ? `${route.name}: no service${nxt ? ` until ${w.city.hhmm(nxt)}` : " tonight"}` : `${route.id} timing UNKNOWN: no timetable and live info too old`;
      return;
    }
    const buf = P.stopBufferS * 1000;
    const pick = (k: number) => {
      const a = arr[k];
      if (a === null) return null;
      for (const tt of timings) {
        if (tt.cancelled) continue;
        if (k === 0 && tt.board[1] >= a) return tt;
        if (k === 1 && tt.board[1] >= a + buf) return tt;
        if (k === 2 && !tt.maybeCancelled && tt.board[0] >= a) return tt;
      }
      return null;
    };
    const chosen = [pick(0), pick(1), pick(2)];
    if (!chosen[1] && !chosen[0]) { this.invalid = `${route.name}: no catchable trip (cancelled or gone)`; return; }
    const ref = (chosen[1] ?? chosen[0])!;
    this.timing = ref;
    const t0 = c.t0;
    const boardOff = chosen.map((cc, k) => (cc ? (cc.board[k] - t0) / 1000 : Infinity)) as Tri;
    const alightOff = chosen.map((cc, k) => (cc ? (cc.alight[k] - t0) / 1000 : Infinity)) as Tri;
    alightOff[0] = Math.min(alightOff[0], alightOff[1]);
    alightOff[2] = Math.max(alightOff[2], alightOff[1]);
    const waitExp = isFinite(boardOff[1]) ? Math.max(0, boardOff[1] - this.cur[1]) : 0;
    const stop = route.stops[leg.board!];
    const change = this.segments.some((x) => x.mode === "bus" || x.mode === "metro");
    const { haven, wcomps } = this.waitPlace(stop, waitExp);
    const start = [...this.cur] as Tri;
    const waitEnd = this.cur.map((a, i) => (isFinite(boardOff[i]) ? Math.max(a, boardOff[i]) : Infinity)) as Tri;
    this.parts.push([waitExp, haven.length ? "haven" : "outdoor", wcomps]);
    const tv: FactView = { ...ref.view, note: ref.note };
    const where = haven.length ? `at ${haven[0].name} (${haven[0].distM} m from the stop)` : `at ${stop.name}`;
    const wseg = this.seg("wait", `Wait ${where} for the ${w.city.hhmm(ref.board[1])} ${route.id} (~${Math.round(waitExp / 60)} min)`, leg, start, waitEnd, 0, [[stop.lat, stop.lon]], wcomps, haven.length ? [tv, haven[0].open] : [tv]);
    Object.assign(wseg, { tripId: ref.trip.id, routeId: route.id, haven: haven[0]?.name ?? null, change });
    this.segments.push(wseg);
    this.cur = waitEnd;
    const { comps: rideComps, rideM, coords } = this.rideParts(route, leg);
    const s0 = [...this.cur] as Tri;
    this.cur = alightOff;
    this.distM += rideM;
    this.parts.push([isFinite(alightOff[1]) ? alightOff[1] - s0[1] : 0, "vehicle", rideComps]);
    const rseg = this.seg(route.mode as Segment["mode"], `${route.id} ${route.stops[leg.board!].name} -> ${route.stops[leg.alight!].name}`, leg, s0, this.cur, rideM, coords, rideComps, [tv]);
    Object.assign(rseg, { tripId: ref.trip.id, routeId: route.id });
    this.segments.push(rseg);
    this.cat("transit_timing", ref.status, ref.conf, `${route.id} ${w.city.hhmm(ref.board[1])}: ${ref.note}`);
    if (ref.conflict) this.warn.push(`Conflicting sources for ${route.id}: ${ref.conflict}`);
    if (!chosen[2]) this.warn.push(`Worst case misses the last catchable ${route.id}`);
    const later = timings.filter((tt) => tt.trip.times[0] > ref.trip.times[0] && !tt.cancelled && tt.board[1] - ref.board[1] < 90 * 60000);
    if (!later.length) {
      const nxt = nextDeparture(w, route.id, ref.trip.times[0] + 60000, pretend);
      this.warn.push(`This is the last ${route.id} for a while (${w.city.hhmm(ref.board[1])}, timing ${ref.status}); ${nxt ? `next service ${w.city.hhmm(nxt)}` : "no later service tonight"}`);
    }
  }
}

function evaluate(c: Ctx, spec: RouteSpec): Plan | { invalid: string; kind: Mode } {
  const ev = new Eval(c, spec);
  for (const leg of spec.legs) {
    if (leg.mode === "walk") ev.walk(leg);
    else ev.transit(leg);
    if (ev.invalid) return { invalid: ev.invalid, kind: spec.kind };
  }
  const cv = c.s.sourceView("closures");
  const er0 = c.riskAt(c.t0);
  ev.cat("closures", cv.status, cv.confidence, `${er0.closures.filter((x) => x.status !== "UNKNOWN").length} closure(s) known; road info ${cv.status}`);
  const tot = ev.parts.reduce((a, [d]) => a + Math.max(d, 1), 0) || 1;
  const comps: Record<string, { lo: number; hi: number }> = {};
  for (const k of COMPONENTS) comps[k] = { lo: ev.parts.reduce((a, [d, , p]) => a + Math.max(d, 1) * p[k].lo, 0) / tot, hi: ev.parts.reduce((a, [d, , p]) => a + Math.max(d, 1) * p[k].hi, 0) / tot };
  const outdoorMin = ev.parts.filter(([, k]) => k === "outdoor").reduce((a, [d]) => a + d, 0) / 60;
  const mult = 0.8 + 0.4 * Math.min(1, outdoorMin / 45);
  const W = CONFIG.risk.weights, wt = COMPONENTS.reduce((a, k) => a + W[k], 0);
  const rLo = Math.min(1, (COMPONENTS.reduce((a, k) => a + W[k] * comps[k].lo, 0) / wt) * mult);
  const rHi = Math.min(1, (COMPONENTS.reduce((a, k) => a + W[k] * comps[k].hi, 0) / wt) * mult);
  const cats = [...ev.cats.values()].map(({ w: _w, ...rest }) => { void _w; return rest; });
  const crit = CRITICAL[spec.kind].filter((n) => ev.cats.has(n));
  for (const cat of cats) {
    cat.critical = crit.includes(cat.name);
    if (cat.critical && (cat.status === "OUTDATED" || cat.status === "UNKNOWN")) ev.warn.push(`Data on ${cat.label.toLowerCase()} is ${cat.status} (${cat.detail}): the ranges are widened to cover it`);
  }
  const critCats = cats.filter((x) => x.critical);
  const tStatus = critCats.length ? weakest(critCats.map((x) => x.status)) : "UNKNOWN";
  const tConf = critCats.reduce((a, x) => a * x.confidence, critCats.length ? 1 : 0);
  const limiting = critCats.length ? critCats.reduce((a, b) => (RANK[b.status] < RANK[a.status] || (b.status === a.status && b.confidence < a.confidence) ? b : a)).name : null;
  const feas: Record<string, boolean> = {};
  CASES.forEach((k, i) => { feas[k] = isFinite(ev.cur[i]) && (c.deadline === null || c.at(ev.cur[i]) <= c.deadline); });
  // the expected case of a route with unknown hours assumes it runs: that would be invented service, so
  // such a way only counts as on time in the best case (never preferred over a way that is expected to work)
  if (ev.usesUnknownHours) feas.expected = false;
  const first = ev.segments[0]?.label ?? "";
  const rides = spec.legs.filter((l) => l.routeId);
  const title = spec.kind === "walk" ? `Walk${first.includes(" via ") ? ` via ${first.split(" via ")[1]}` : ""}`
    : `${rides.map((l) => l.routeId).join(" + ")} from ${rides[0]?.a[2] ?? ""}${rides.length > 1 ? ` (${rides.length - 1} change${rides.length > 2 ? "s" : ""})` : ""}`;
  return {
    id: spec.sig, kind: spec.kind, lam: spec.lam, labels: [], modes: [...new Set(ev.segments.filter((x) => x.mode !== "wait").map((x) => x.mode))], title,
    eta: ev.times(ev.cur), durationMin: Object.fromEntries(CASES.map((k, i) => [k, isFinite(ev.cur[i]) ? Math.round(ev.cur[i] / 6) / 10 : null])), feasible: feas,
    safety: { lo: Math.round(100 * (1 - rHi)), hi: Math.round(100 * (1 - rLo)) },
    risk: Object.fromEntries(COMPONENTS.map((k) => [k, { lo: Math.round(Math.min(1, comps[k].lo * mult) * 1000) / 1000, hi: Math.round(Math.min(1, comps[k].hi * mult) * 1000) / 1000 }])),
    trust: { status: tStatus, confidence: Math.round(tConf * 1000) / 1000, limiting, overall: cats.length ? weakest(cats.map((x) => x.status)) : "UNKNOWN",
      categories: cats.sort((a, b) => Number(!a.critical) - Number(!b.critical) || RANK[a.status] - RANK[b.status]) },
    segments: ev.segments, distanceM: Math.round(ev.distM), walkM: Math.round(ev.walkM), outdoorMin: Math.round(outdoorMin * 10) / 10,
    warnings: ev.warn, safeHavens: ev.havens, openAlong: [...ev.along.values()].slice(0, 6), dependsOn: crit, explanation: "", leaveAdvice: null,
  };
}

// ---- selection --------------------------------------------------------------------------------------
function utility(p: Plan, rw: number, lo: number, hi: number): number {
  const e = p.durationMin.expected ?? 1e9;
  return (rw * p.safety.lo) / 100 + (1 - rw) * (1 - (e - lo) / Math.max(hi - lo, 1)) * 0.6;
}

export function choosePlanB(rec: Plan, plans: Plan[]): { plan: Plan; weakLink: string; weakStatus: Status; reason: string; trigger: string } | null {
  const weak = rec.trust.limiting;
  if (!weak) return null;
  // a way that walks beyond the limit (e.g. 27 km at night) is never a Backup: waiting somewhere safe is
  const overLimit = (p: Plan) => p.warnings.some((x) => x.startsWith("Walks ")) && !rec.warnings.some((x) => x.startsWith("Walks "));
  const usable = plans.filter((p) => p.id !== rec.id && !overLimit(p));
  let cands = usable.filter((p) => !p.dependsOn.includes(weak));
  if (weak === "closures" || !cands.length) cands = usable.filter((p) => p.kind !== rec.kind);
  if (!cands.length) return null;
  const best = cands.reduce((a, b) => {
    const ka = [Number(a.feasible.worst), Number(a.feasible.expected), a.safety.lo], kb = [Number(b.feasible.worst), Number(b.feasible.expected), b.safety.lo];
    return kb[0] > ka[0] || (kb[0] === ka[0] && (kb[1] > ka[1] || (kb[1] === ka[1] && kb[2] > ka[2]))) ? b : a;
  });
  const wc = rec.trust.categories.find((x) => x.name === weak)!;
  const trig: Record<string, string> = { transit_timing: "if the bus has not come 5 minutes after its time",
    closures: "if you meet a closure on the way", weather: "if it starts raining heavily" };
  return { plan: best, weakLink: weak, weakStatus: wc.status, reason: `Data on ${wc.label.toLowerCase()} is ${wc.status === "PROBABLE" ? "only " : ""}${wc.status} (${wc.detail})`,
    trigger: `Switch to ${best.title} ${trig[weak] ?? "if things change"}.` };
}

function explain(c: Ctx, p: Plan, planB: ReturnType<typeof choosePlanB>): string {
  const bits: string[] = [];
  const cats = Object.fromEntries(p.trust.categories.map((x) => [x.name, x]));
  if (p.labels.includes("Safest")) bits.push(`highest worst-case safety (${p.safety.lo})`);
  if (p.labels.includes("Fastest")) bits.push(`quickest expected arrival (${Math.round(p.durationMin.expected ?? 0)} min)`);
  if (p.kind === "walk" && cats.lighting) bits.push(`lighting: ${cats.lighting.detail}`);
  if ((p.kind === "bus" || p.kind === "metro") && cats.transit_timing) bits.push(cats.transit_timing.detail);
  if (p.openAlong.length) bits.push(`passes ${p.openAlong.length} open place(s) on foot`);
  if (!bits.length) bits.push(`worst-case safety ${p.safety.lo}`);
  let t = (p.labels.includes("Recommended") ? "Chosen because: " : "") + bits.join("; ") + ".";
  const weak = p.trust.categories.find((x) => x.critical && x.status !== "KNOWN");
  if (weak) t += ` Data on ${weak.label.toLowerCase()} is ${weak.status}${planB ? `, so a Plan B (${planB.plan.title}) is included` : ""}.`;
  void c;
  return t[0].toUpperCase() + t.slice(1);
}

function leaveAdvice(c: Ctx, p: Plan): string | null {
  const out: string[] = [];
  const dl = c.deadline, w = c.w;
  if (p.kind === "bus" || p.kind === "metro") {
    const walk = p.segments[0], wait = p.segments.find((s) => s.mode === "wait");
    if (walk?.end.worst && wait?.end.expected) {
      const slack = (wait.end.expected - walk.end.worst) / 1000 - 60;
      if (slack < 0) out.push(`Leave ${Math.ceil(-slack / 60)} min earlier to be sure of the ${w.city.hhmm(wait.end.expected)} bus.`);
    }
  }
  if (dl !== null) {
    if (p.eta.worst) {
      const latest = dl - (p.eta.worst - c.t0);
      if (latest >= c.t0 + 180000) out.push(`Leave by ${w.city.hhmm(latest)} to be there by ${w.city.hhmm(dl)} even in the worst case.`);
      else if (latest >= c.t0) out.push(`Leave now: only ${Math.floor((latest - c.t0) / 60000)} min of worst-case spare time.`);
      else out.push(`Worst case is ${Math.round((p.eta.worst - dl) / 60000)} min late; leave earlier or tell your contact.`);
    } else out.push("The worst case has no catchable connection: keep Plan B ready.");
  }
  return out.join(" ") || null;
}

export function planFull(s: State, req: PlanRequest, cache: OpenCache, pinned: RouteSpec | null = null): { ps: PlanSet; specs: Map<string, RouteSpec>; all: Plan[] } {
  const w = s.world, now = s.now();
  const departure = req.start ?? now;
  const c = new Ctx(s, req, cache, departure);
  c.deadline = req.deadline ?? null;
  if (c.deadline !== null && c.deadline < departure - 3600000) c.deadline += 86400000;
  let phase: PlanSet["phase"] = now < departure ? "before_departure" : "in_progress";
  if (phase === "in_progress") c.notes.push(`Trip in progress since ${w.city.hhmm(departure)} (assumed you left on time)`);
  const modes = new Set<Mode>([...(req.modes ?? ["walk", "bus", "metro"]), "walk"]);
  if (modes.has("bus")) modes.add("metro");                 // "bus" in a request means public transport
  let specs: RouteSpec[] = walkCandidates(c);
  const transitModes = new Set([...modes].filter((x) => x !== "walk"));
  if (transitModes.size) specs.push(...transitCandidates(c, transitModes));
  if (pinned) specs = [pinned, ...specs];
  const uniq: RouteSpec[] = [];
  for (const sp of specs) {
    if (uniq.some((u) => u.sig === sp.sig || (u.kind === sp.kind && sp.kind === "walk" && overlap(sp, u, w) > P.dedupeOverlap))) continue;
    uniq.push(sp);
  }
  const plans: Plan[] = [], specById = new Map<string, RouteSpec>();
  let pinnedInvalid: string | null = null;
  uniq.forEach((sp, i) => {
    const r = evaluate(c, sp);
    if ("invalid" in r) {
      if (i === 0 && pinned) pinnedInvalid = r.invalid;
      if ((r.kind === "bus" || r.kind === "metro") && !c.notes.includes(r.invalid)) c.notes.push(r.invalid);
      return;
    }
    plans.push(r); specById.set(r.id, sp);
  });
  const maxWalk = req.maxWalkM ?? P.maxWalkM, rw = req.riskWeight ?? 0.7;
  for (const p of plans) if (p.walkM > maxWalk) p.warnings.push(`Walks ${fmtM(p.walkM)}, more than your limit of ${fmtM(maxWalk)}`);
  const within = plans.filter((p) => p.walkM <= maxWalk).length ? plans.filter((p) => p.walkM <= maxWalk) : plans;
  let pool: Plan[] = [], level = "none";
  for (const lv of ["worst", "expected", "best"]) { pool = within.filter((p) => p.feasible[lv]); if (pool.length) { level = lv; break; } }
  const noFeasible = !pool.length;
  if (noFeasible) pool = within;
  const warnings = [...c.warnings];
  if (c.deadline !== null) {
    if (level === "expected") warnings.push("No way is on time in the worst case; showing ways that make it in the expected case.");
    else if (level === "best") warnings.push("Only best-case timings reach your deadline: plan for being late.");
    else if (noFeasible) warnings.push("No way reaches your deadline even in the best case. Showing the closest options.");
  }
  const out: Plan[] = [];
  let rec: Plan | null = null;
  if (pool.length) {
    const etas = pool.map((p) => p.durationMin.expected ?? 1e9), lo = Math.min(...etas), hi = Math.max(...etas);
    const by = (f: (p: Plan) => number) => pool.reduce((a, b) => (f(b) > f(a) ? b : a));
    const fastest = by((p) => -(p.durationMin.expected ?? 1e9) * 1000 + p.safety.lo);
    const safest = by((p) => p.safety.lo * 1e6 - (p.durationMin.expected ?? 1e9));
    const others = pool.filter((p) => p !== fastest && p !== safest);
    const balanced = (others.length ? others : pool).reduce((a, b) => (utility(b, 0.5, lo, hi) > utility(a, 0.5, lo, hi) ? b : a));
    rec = by((p) => utility(p, rw, lo, hi));
    fastest.labels.push("Fastest"); safest.labels.push("Safest");
    if (balanced !== fastest && balanced !== safest) balanced.labels.push("Balanced");
    rec.labels.unshift("Recommended");
    for (const p of [rec, safest, fastest, balanced]) if (!out.includes(p)) out.push(p);
  }
  const pb = rec ? choosePlanB(rec, plans) : null;
  if (pb) { if (!out.includes(pb.plan)) out.push(pb.plan); pb.plan.labels.push("Plan B"); }
  const kinds = new Set(out.map((p) => p.kind));
  for (const p of [...plans].sort((a, b) => b.safety.lo - a.safety.lo)) {
    if (out.length >= 4) break;
    if (!out.includes(p) && !kinds.has(p.kind)) { p.labels.push("Alternative"); if (!p.feasible.worst && c.deadline !== null) p.warnings.unshift("May miss your deadline in the worst case"); out.push(p); kinds.add(p.kind); }
  }
  // "Other ways" (U3): compare up to 6 distinct ways the way routing.py did; keep the compared ones in the set
  const cand = [...out, ...plans.filter((p) => !out.includes(p)).sort((a, b) => b.safety.lo - a.safety.lo)].slice(0, 6);
  const metrics = (p: Plan): CandidateMetrics => ({ id: p.id, durationMin: { best: p.durationMin.best, expected: p.durationMin.expected, worst: p.durationMin.worst },
    safety: p.safety, outdoorMin: p.outdoorMin, lightingDetail: p.trust.categories.find((x) => x.name === "lighting")?.detail ?? null,
    havenDistM: p.safeHavens.length ? Math.min(...p.safeHavens.map((h) => h.distM ?? 500)) : null, feasibleWorst: !!p.feasible.worst,
    worstEta: p.eta.worst, limitingStatus: p.trust.status });
  const compare = cand.length >= 2 ? compareWays(cand.map(metrics), c.deadline) : undefined;
  if (compare) for (const wy of compare.ways) { const p = cand.find((x) => x.id === wy.id)!; if (!out.includes(p)) { p.labels.push("Other way"); out.push(p); } }
  for (const p of plans) { p.explanation = explain(c, p, p === rec ? pb : null); p.leaveAdvice = leaveAdvice(c, p); }
  if (rec?.eta.worst && rec.eta.worst + 600000 < now) phase = "arrived";
  const er0 = c.riskAt(departure);
  const ox = w.proj.x(req.origin.lon), oy = w.proj.y(req.origin.lat);
  const ps: PlanSet = {
    phase, computedAt: now, departure, deadline: c.deadline, plans: out, recommendedId: rec?.id ?? null,
    planB: pb ? { planId: pb.plan.id, weakLink: pb.weakLink, weakStatus: pb.weakStatus, reason: pb.reason, trigger: pb.trigger } : null,
    feasibilityLevel: noFeasible ? "none" : level, noFeasible, warnings, notes: c.notes, weather: er0.weather.view,
    closures: er0.closures.map(({ id, name, reason, kind, lat, lon, status }) => ({ id, name, reason, kind, lat, lon, status })),
    havensNearOrigin: havensNear(s, cache, departure, ox, oy, 400, 3), pinnedInvalid, compare,
  };
  return { ps, specs: specById, all: plans };
}

export { CI, type RiskComponent };

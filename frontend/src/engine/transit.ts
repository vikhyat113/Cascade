// Buses and metro: trips expanded from the timetable for the current night, the timing of one trip from
// realtime (fresh = KNOWN) or the timetable (PROBABLE), and the itinerary search with transfers (U4).
// Routes whose service hours are not known get NO trips (never invented night service), unless the Demo
// switch "Pretend night buses run (simulated)" is on.
import { CONFIG, SOURCES } from "../config";
import type { Fact, FactView, Status } from "./freshness";
import type { State } from "./state";
import type { Route, World } from "./world";

export interface Trip { id: string; routeId: string; dir: "A" | "B"; stopPos: number[]; times: number[] }

const cache = new WeakMap<World, Map<string, { trips: Trip[]; byRouteDir: Map<string, Trip[]> }>>();

/** Service a route runs on: its real hours, or (Demo pretend only) all night at the assumed headway. */
function serviceOf(r: Route, pretend: boolean): Route["service"] {
  if (r.hoursKnown) return r.service;
  if (!pretend) return [];
  return [{ from: "12:00", to: "11:59", headway_min: r.headwayMin ?? CONFIG.transit.unknownHeadwayMin }];
}

export function tripsFor(w: World, ref: number, pretend = false): { trips: Trip[]; byRouteDir: Map<string, Trip[]> } {
  const night = w.city.nightStart(ref);
  const key = `${night}|${pretend}`;
  let byWorld = cache.get(w);
  if (!byWorld) { byWorld = new Map(); cache.set(w, byWorld); }
  const c = byWorld.get(key);
  if (c) return c;
  const trips: Trip[] = [];
  const byRouteDir = new Map<string, Trip[]>();
  for (const r of w.routes.values()) {
    const deps = new Set<number>();
    for (const s of serviceOf(r, pretend)) {
      const a = w.city.atNight(s.from, ref);
      let b = w.city.atNight(s.to, ref);
      if (b < a) b += 86400000;
      for (let t = a; t <= b; t += s.headway_min * 60000) deps.add(t);
    }
    const n = r.stops.length;
    for (const dir of (r.both ? ["A", "B"] : ["A"]) as ("A" | "B")[]) {
      const pos = dir === "A" ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
      const segs = dir === "A" ? r.segS : [...r.segS].reverse();
      const list: Trip[] = [];
      for (const d of [...deps].sort((x, y) => x - y)) {
        const times = [d];
        for (const sg of segs) times.push(times[times.length - 1] + sg * 1000);
        const trip = { id: `${r.id}-${dir}-${w.city.hhmm(d).replace(":", "")}`, routeId: r.id, dir, stopPos: pos, times };
        list.push(trip);
        trips.push(trip);
      }
      byRouteDir.set(`${r.id}|${dir}`, list);
    }
  }
  const out = { trips, byRouteDir };
  byWorld.set(key, out);
  return out;
}

export function stopsNear(w: World, x: number, y: number, radius: number, mode: string): { routeId: string; k: number; d: number }[] {
  const out: { routeId: string; k: number; d: number }[] = [];
  for (const r of w.routes.values()) {
    if (r.mode !== mode) continue;
    r.stops.forEach((s, k) => { const d = Math.hypot(s.x - x, s.y - y); if (d <= radius) out.push({ routeId: r.id, k, d }); });
  }
  return out.sort((a, b) => a.d - b.d);
}

export function tripsAfter(w: World, route: Route, dir: string, stopK: number, t: number, limit = 8, pretend = false): Trip[] {
  const list = tripsFor(w, t, pretend).byRouteDir.get(`${route.id}|${dir}`) ?? [];
  const out: Trip[] = [];
  for (const trip of list) {
    const p = trip.stopPos.indexOf(stopK);
    if (p >= 0 && trip.times[p] >= t - 900000) { out.push(trip); if (out.length >= limit) break; }
  }
  return out;
}

export function nextDeparture(w: World, routeId: string, t: number, pretend = false): number | null {
  const list = tripsFor(w, t, pretend).byRouteDir.get(`${routeId}|A`) ?? [];
  const n = list.find((tr) => tr.times[0] >= t);
  return n ? n.times[0] : null;
}

export interface TripTiming {
  trip: Trip; board: [number, number, number]; alight: [number, number, number];
  view: FactView; status: Status; conf: number; cancelled: boolean; maybeCancelled: boolean; note: string; conflict: string | null;
}

export function tripTiming(s: State, trip: Trip, kb: number, ka: number): TripTiming | null {
  const w = s.world;
  const route = w.routes.get(trip.routeId)!;
  const pb = trip.stopPos.indexOf(kb), pa = trip.stopPos.indexOf(ka);
  if (pb < 0 || pa < 0 || pa <= pb) return null;
  const sb = trip.times[pb], sa = trip.times[pa];
  const src = SOURCES.transit_schedule;
  const pretended = !route.hoursKnown;                          // only here when the Demo pretend switch is on
  let sched: Fact | null = s.available("transit_schedule")
    ? { key: `transit:sched:${trip.id}`, value: sb, source: "transit_schedule", synthetic: route.synthetic || pretended, observedAt: w.scheduleGeneratedAt, ttlS: src.ttlS,
        reliability: route.synthetic ? 0.55 : src.reliability, kind: "scheduled", note: pretended ? `simulated night service ${w.city.hhmm(sb)}` : `timetable ${w.city.hhmm(sb)}` }
    : null;
  const rt = s.get(`transit:rt:${trip.id}`) ?? null;
  const rs = s.statusOf(rt);
  const ride = (sa - sb) / 1000;
  let d = 0, loB = -60, hiB = 480, cancelled = false, maybe = false, used: Fact | null, note: string, conflict: string | null = null;
  if (rs === "KNOWN" || rs === "PROBABLE") {
    const v = rt!.value as { delay_s: number; cancelled: boolean };
    d = v.delay_s; cancelled = v.cancelled;
    [loB, hiB] = rs === "KNOWN" ? [-30, 90] : [-60, 240];
    used = rt;
    if (sched && (cancelled || Math.abs(d) > 300)) {
      conflict = `timetable says ${w.city.hhmm(sb)}, live says ${cancelled ? "cancelled" : `${Math.round(d / 60)} min late`}: trusting the newer observation`;
      sched = { ...sched, contradictedBy: rt!.key };
    }
    note = cancelled ? "cancelled (live)" : `live ${rs}: ${d >= 0 ? "+" : ""}${Math.round(d / 60)} min`;
  } else if (rs === "OUTDATED" || sched) {
    if (rs === "OUTDATED") {
      const v = rt!.value as { delay_s: number; cancelled: boolean };
      d = v.delay_s; maybe = v.cancelled;
      loB = -90 + Math.min(d, 0) - d; hiB = Math.max(d, 0) + 600 - d;           // old delay kept, band widened
    }
    if (route.synthetic) hiB = Math.max(hiB, 900);                              // estimated route: wider band
    used = sched ?? rt;
    const age = rt ? s.view(rt).ageS : null;
    note = rs === "OUTDATED" ? `live OUTDATED (last seen ${Math.round((age ?? 0) / 60)} min ago); using timetable`
      : pretended ? "simulated night service (Demo), timetable only" : "timetable only (no live)";
  } else {
    return null;                                 // neither live nor timetable: timing UNKNOWN, never guessed
  }
  const board: [number, number, number] = [sb + (d + loB) * 1000, sb + d * 1000, sb + (d + hiB) * 1000];
  const alight: [number, number, number] = [sa + (d + loB - 0.05 * ride) * 1000, sa + d * 1000, sa + (d + hiB + 0.15 * ride) * 1000];
  const v = s.view(used);
  return { trip, board, alight, view: v, status: v.status, conf: v.confidence, cancelled, maybeCancelled: maybe, note, conflict };
}

// ---- itineraries with transfers (RAPTOR-lite, UPGRADE §5.4) ------------------------------------------
// Rounds over stops: board a route at a stop reached in the previous round, ride, get off anywhere later,
// then walk up to `transferRadiusM` to change. Costs are expected seconds (walk + headway/2 wait + ride +
// a penalty per change); exact times are worked out afterwards by the planner from real trips.

export interface Ride { routeId: string; dir: "A" | "B"; board: number; alight: number }
export interface Itinerary { rides: Ride[]; cost: number; transfers: number }

interface Cluster { id: number; x: number; y: number; name: string; members: { routeId: string; k: number }[] }
const clusterCache = new WeakMap<World, { clusters: Cluster[]; at: Map<string, number>; near: number[][] }>();

/** Stops of all routes grouped into places (same name within clusterM, or within 25 m), with walk links. */
export function stopClusters(w: World) {
  const c = clusterCache.get(w);
  if (c) return c;
  const T = CONFIG.transit;
  const clusters: Cluster[] = [];
  const at = new Map<string, number>();
  const base = (n: string) => n.toLowerCase().replace(/\s*\((orange|aqua) line\)|\s+\d+$/g, "").trim();
  for (const r of w.routes.values()) r.stops.forEach((s, k) => {
    let best = -1;
    for (const cl of clusters) {
      const d = Math.hypot(cl.x - s.x, cl.y - s.y);
      if (d <= 25 || (d <= T.clusterM && base(cl.name) === base(s.name))) { best = cl.id; break; }
    }
    if (best < 0) { best = clusters.length; clusters.push({ id: best, x: s.x, y: s.y, name: s.name, members: [] }); }
    clusters[best].members.push({ routeId: r.id, k });
    at.set(`${r.id}|${k}`, best);
  });
  const near = clusters.map((a) => clusters.filter((b) => b !== a && Math.hypot(a.x - b.x, a.y - b.y) <= T.transferRadiusM).map((b) => b.id));
  const out = { clusters, at, near };
  clusterCache.set(w, out);
  return out;
}

export function itineraries(w: World, from: { x: number; y: number }, to: { x: number; y: number }, opts: { modes: Set<string>; accessM: number; walkMps: number }): Itinerary[] {
  const T = CONFIG.transit;
  const { clusters, at, near } = stopClusters(w);
  const n = clusters.length;
  const walkS = (d: number) => (d * 1.3) / opts.walkMps;
  type Label = { cost: number; prev: number; ride: Ride | null; walkFrom: number };
  const rounds: Label[][] = [];         // best label per stop after round r (ride, or ride + walk to change)
  const rideLabels: Label[][] = [[]];   // the ride label per stop in round r (for rebuilding the trip)
  // round 0: walking from the origin
  const r0: Label[] = Array.from({ length: n }, () => ({ cost: Infinity, prev: -1, ride: null, walkFrom: -1 }));
  for (const cl of clusters) {
    const d = Math.hypot(cl.x - from.x, cl.y - from.y);
    if (d <= opts.accessM) r0[cl.id] = { cost: walkS(d), prev: -1, ride: null, walkFrom: -1 };
  }
  rounds.push(r0);
  const routes = [...w.routes.values()].filter((r) => opts.modes.has(r.mode));
  for (let round = 1; round <= T.maxTransfers + 1; round++) {
    const prev = rounds[round - 1];
    const cur: Label[] = Array.from({ length: n }, () => ({ cost: Infinity, prev: -1, ride: null, walkFrom: -1 }));
    for (const r of routes) {
      const wait = ((r.headwayMin ?? T.unknownHeadwayMin) * 60) / 2 + (round > 1 ? T.transferPenaltyS : 0);
      for (const dir of (r.both ? ["A", "B"] : ["A"]) as ("A" | "B")[]) {
        const order = dir === "A" ? [...r.stops.keys()] : [...r.stops.keys()].reverse();
        let boarded = Infinity, boardK = -1, boardCl = -1, rideS = 0;
        for (let i = 0; i < order.length; i++) {
          const k = order[i], cl = at.get(`${r.id}|${k}`)!;
          if (i > 0 && boardK >= 0) {
            const segIdx = dir === "A" ? order[i - 1] : k;          // seg between consecutive stops
            rideS += r.segS[segIdx];
            const arr = boarded + rideS;
            if (arr < cur[cl].cost) cur[cl] = { cost: arr, prev: boardCl, ride: { routeId: r.id, dir, board: boardK, alight: k }, walkFrom: -1 };
          }
          const can = prev[cl].cost + wait;
          if (can < boarded + rideS) { boarded = can; boardK = k; boardCl = cl; rideS = 0; }
        }
      }
    }
    // walk to nearby stops to change (kept separate so a ride label is not overwritten)
    const withWalk = cur.map((l) => ({ ...l }));
    for (let a = 0; a < n; a++) {
      if (!isFinite(cur[a].cost) || !cur[a].ride) continue;
      for (const b of near[a]) {
        const c2 = cur[a].cost + walkS(Math.hypot(clusters[a].x - clusters[b].x, clusters[a].y - clusters[b].y));
        if (c2 < withWalk[b].cost) withWalk[b] = { cost: c2, prev: -1, ride: null, walkFrom: a };
      }
    }
    rounds.push(withWalk);
    rideLabels.push(cur);
  }
  // egress + rebuild: best few per number of rides
  const out: Itinerary[] = [];
  for (let round = 1; round < rounds.length; round++) {
    const ends: [number, number][] = [];
    for (const cl of clusters) {
      const d = Math.hypot(cl.x - to.x, cl.y - to.y);
      const l = rounds[round][cl.id];
      if (d <= opts.accessM && isFinite(l.cost)) ends.push([l.cost + walkS(d), cl.id]);
    }
    ends.sort((a, b) => a[0] - b[0]);
    for (const [cost, end] of ends.slice(0, 3)) {
      const rides: Ride[] = [];
      let cl = end, r = round, ok = true;
      while (r > 0) {
        const best = rounds[r][cl];
        if (best.walkFrom >= 0) cl = best.walkFrom;
        const l = rideLabels[r][cl];
        if (!l?.ride) { ok = false; break; }
        rides.unshift(l.ride);
        cl = l.prev; r--;
      }
      if (!ok || rides.length !== round) continue;
      if (rides.some((x, i) => i > 0 && x.routeId === rides[i - 1].routeId)) continue;    // same route twice: not a real change
      out.push({ rides, cost, transfers: rides.length - 1 });
    }
  }
  const seen = new Set<string>();
  return out.sort((a, b) => a.cost - b.cost).filter((it) => {
    const k = it.rides.map((x) => `${x.routeId}${x.dir}`).join(">");     // one option per sequence of routes
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, T.maxItineraries);
}

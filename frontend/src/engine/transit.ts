// Night buses: trips expanded from the (synthetic, hand-built) timetable for the current night,
// and the timing of one trip from realtime (fresh = KNOWN) or the timetable (PROBABLE).
import { CONFIG, SOURCES } from "../config";
import type { Fact, FactView, Status } from "./freshness";
import type { State } from "./state";
import type { Route, World } from "./world";

export interface Trip { id: string; routeId: string; dir: "A" | "B"; stopPos: number[]; times: number[] }

const cache = new WeakMap<World, { night: number; trips: Trip[]; byRouteDir: Map<string, Trip[]> }>();

export function tripsFor(w: World, ref: number): { trips: Trip[]; byRouteDir: Map<string, Trip[]> } {
  const night = w.city.nightStart(ref);
  const c = cache.get(w);
  if (c && c.night === night) return c;
  const trips: Trip[] = [];
  const byRouteDir = new Map<string, Trip[]>();
  for (const r of w.routes.values()) {
    const deps = new Set<number>();
    for (const s of r.service) {
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
  const out = { night, trips, byRouteDir };
  cache.set(w, out);
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

export function tripsAfter(w: World, route: Route, dir: string, stopK: number, t: number, limit = 8): Trip[] {
  const list = tripsFor(w, t).byRouteDir.get(`${route.id}|${dir}`) ?? [];
  const out: Trip[] = [];
  for (const trip of list) {
    const p = trip.stopPos.indexOf(stopK);
    if (p >= 0 && trip.times[p] >= t - 900000) { out.push(trip); if (out.length >= limit) break; }
  }
  return out;
}

export function nextDeparture(w: World, routeId: string, t: number): number | null {
  const list = tripsFor(w, t).byRouteDir.get(`${routeId}|A`) ?? [];
  const n = list.find((tr) => tr.times[0] >= t);
  return n ? n.times[0] : null;
}

export interface TripTiming {
  trip: Trip; board: [number, number, number]; alight: [number, number, number];
  view: FactView; status: Status; conf: number; cancelled: boolean; maybeCancelled: boolean; note: string; conflict: string | null;
}

export function tripTiming(s: State, trip: Trip, kb: number, ka: number): TripTiming | null {
  const w = s.world;
  const pb = trip.stopPos.indexOf(kb), pa = trip.stopPos.indexOf(ka);
  if (pb < 0 || pa < 0 || pa <= pb) return null;
  const sb = trip.times[pb], sa = trip.times[pa];
  const src = SOURCES.transit_schedule;
  let sched: Fact | null = s.available("transit_schedule")
    ? { key: `transit:sched:${trip.id}`, value: sb, source: "transit_schedule", synthetic: w.scheduleSynthetic, observedAt: w.scheduleGeneratedAt, ttlS: src.ttlS, reliability: src.reliability, kind: "scheduled", note: `timetable ${w.city.hhmm(sb)}` }
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
    used = sched ?? rt;
    const age = rt ? s.view(rt).ageS : null;
    note = rs === "OUTDATED" ? `live OUTDATED (last seen ${Math.round((age ?? 0) / 60)} min ago); using timetable` : "timetable only (no live)";
  } else {
    return null;                                 // neither live nor timetable: timing UNKNOWN, never guessed
  }
  const board: [number, number, number] = [sb + (d + loB) * 1000, sb + d * 1000, sb + (d + hiB) * 1000];
  const alight: [number, number, number] = [sa + (d + loB - 0.05 * ride) * 1000, sa + d * 1000, sa + (d + hiB + 0.15 * ride) * 1000];
  const v = s.view(used);
  return { trip, board, alight, view: v, status: v.status, conf: v.confidence, cancelled, maybeCancelled: maybe, note, conflict };
}

// ---- cab / auto availability: time-of-night x area density model (PROBABLE) ---------------------------
export function cabWait(s: State, lat: number, lon: number, t: number): { lo: number; exp: number; hi: number; view: FactView } {
  const w = s.world;
  const zone = w.cgrid.index(w.proj.x(lon), w.proj.y(lat));
  const h = w.city.hour(t);
  const base = CONFIG.cab.baseWaitMin[h] ?? 10;
  const dens = w.zoneDensity[zone] ?? 0;
  const exp = base * (1.6 - 0.45 * Math.min(dens, 2));        // a model only: never reads simulator truth
  let hi = exp * 2.2;
  if (h >= 2 && h <= 4 && dens < 0.3) hi *= 1.3;                 // sparse area in the dead of night
  const f: Fact = { key: `cab:zone:${zone}`, value: { wait_min: Math.round(exp * 10) / 10 }, source: "prior", synthetic: true,
    observedAt: w.mapAt, ttlS: 31536000, reliability: 0.6, kind: "prior", note: "night-time availability model (hour x area)" };
  return { lo: exp * 0.5 * 60, exp: exp * 60, hi: hi * 60, view: s.view(f, { interval: [Math.round(exp * 5) / 10, Math.round(hi * 10) / 10] }) };
}

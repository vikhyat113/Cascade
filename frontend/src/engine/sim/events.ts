// Things the Demo drawer and scenarios can make happen. They change the ground truth or switch
// sources; the planner only finds out through the feeds.
import { LIVE_SOURCES, SOURCES, type SourceId } from "../../config";
import type { State } from "../state";
import { tripsFor } from "../transit";
import { MAIN } from "../world";

export type SourceArg = SourceId | "all_live" | "all";

export function setSource(s: State, source: SourceArg, enabled: boolean): SourceId[] {
  const ids: SourceId[] = source === "all_live" ? [...LIVE_SOURCES] : source === "all" ? (Object.keys(SOURCES) as SourceId[]).filter((k) => k !== "osm_map") : [source];
  const changed = ids.filter((id) => id !== "osm_map" && s.sources[id] && s.sources[id].enabled !== enabled);
  for (const id of changed) s.sources[id].enabled = enabled;
  if (changed.length) s.logEvent(enabled ? "restore" : "outage", `${enabled ? "restored" : "OFF"}: ${changed.map((c) => SOURCES[c].label).join(", ")}`, enabled ? "info" : "warn");
  return changed;
}

export interface PlanContext { edges?: number[]; near?: [number, number]; route?: string; trip?: string }

/** Longest named main road the current way uses (for "Road closed" / "Accident"). */
function mainRoadOn(s: State, edges: number[]): [number, number, string] | null {
  const w = s.world;
  const by = new Map<string, [number, number]>();
  for (const e of edges) {
    const nm = w.ename[e];
    if (!nm || !MAIN.has(w.ehw[e])) continue;
    const cur = by.get(nm) ?? [0, e];
    by.set(nm, [cur[0] + w.elen[e], cur[1]]);
  }
  let best: [number, number, string] | null = null, bl = 0;
  for (const [nm, [L, e]] of by) if (L > bl) { bl = L; best = [w.proj.lat(w.emy[e]), w.proj.lon(w.emx[e]), nm]; }
  return best;
}

export function addClosure(s: State, lat: number, lon: number, kind: "closure" | "accident", reason: string, name?: string | null, radius = 350) {
  const w = s.world;
  const x = w.proj.x(lon), y = w.proj.y(lat);
  let nm = name ?? null;
  if (!nm) {
    let bd = 400;
    for (let e = 0; e < w.m; e++) { const d = Math.hypot(w.emx[e] - x, w.emy[e] - y); if (d < bd && w.ename[e] && MAIN.has(w.ehw[e])) { bd = d; nm = w.ename[e]; } }
  }
  const edges: number[] = [];
  for (let e = 0; e < w.m; e++) {
    const d = Math.hypot(w.emx[e] - x, w.emy[e] - y);
    if (nm ? d < radius && w.ename[e] === nm : d < 60) edges.push(e);
  }
  const id = s.nextId("cl");
  s.truth.closures.set(id, { name: nm ?? "a street", reason, kind, edges, lat, lon, since: s.now() });
  if (kind === "accident") s.truth.accidents.set(w.tgrid.index(x, y), 0.35);
  s.logEvent("event", `[truth] ${kind} on ${nm ?? "a street"}: ${reason} (${edges.length} segments)`, "warn");
  return id;
}

export function setRain(s: State, intensity: string | null): void {
  s.truth.rain = intensity && intensity !== "none" ? intensity : null;
  s.truth.rainSince = s.truth.rain ? s.now() : null;
  s.logEvent("event", `[truth] rain ${s.truth.rain ? `started: ${s.truth.rain}` : "stopped"}`, s.truth.rain ? "warn" : "info");
}

export function cancelTrip(s: State, routeId: string, tripId?: string | null): string | null {
  const now = s.now();
  const all = tripsFor(s.world, now).trips;
  const first = tripId ? all.find((t) => t.id === tripId) : undefined;
  const pool = all.filter((t) => t.routeId === routeId && (!first || t.dir === first.dir) && t.times[0] >= (first ? first.times[0] : now - 20 * 60000))
    .sort((a, b) => a.times[0] - b.times[0]);
  if (!pool.length) return null;
  for (const t of pool.slice(0, 2)) s.truth.cancelledTrips.add(t.id);
  s.logEvent("event", `[truth] bus ${routeId}: trips from ${s.world.city.hhmm(pool[0].times[0])} cancelled`, "warn");
  return pool[0].id;
}

export interface SimEvent { t?: string; type: string; params?: Record<string, unknown> }

export function applyEvent(s: State, ev: SimEvent, ctx: PlanContext = {}): Record<string, unknown> {
  const p = ev.params ?? {};
  switch (ev.type) {
    case "source_outage": return { changed: setSource(s, (p.source as SourceArg) ?? "all_live", false) };
    case "source_restore": return { changed: setSource(s, (p.source as SourceArg) ?? "all_live", true) };
    case "rain_start": setRain(s, (p.intensity as string) ?? "heavy"); return {};
    case "rain_stop": setRain(s, null); return {};
    case "road_closure":
    case "accident": {
      let lat = p.lat as number | undefined, lon = p.lon as number | undefined, name = (p.name as string) ?? null;
      if (p.edge_selector === "main_road_nearest_route" && ctx.edges?.length) {
        const hit = mainRoadOn(s, ctx.edges);
        if (hit) [lat, lon, name] = hit;
      }
      if (lat === undefined || lon === undefined) [lat, lon] = ctx.near ?? [s.world.meta.center.lat, s.world.meta.center.lon];
      return { id: addClosure(s, lat, lon, ev.type === "accident" ? "accident" : "closure", (p.reason as string) ?? (ev.type === "accident" ? "accident" : "police barricade"), name) };
    }
    case "bus_cancelled": {
      const rid = (p.route as string) ?? ctx.route;
      if (!rid) return { error: "no bus on the current way" };
      return { trip: cancelTrip(s, rid, p.route ? null : ctx.trip) };
    }
    case "schedule_conflict": {
      const rid = (p.route as string) ?? ctx.route;
      if (rid) { s.truth.scheduleConflicts.set(rid, Number(p.delay_s ?? 900)); s.logEvent("event", `[truth] bus ${rid} runs ${Math.round(Number(p.delay_s ?? 900) / 60)} min behind its timetable`, "warn"); }
      return { route: rid };
    }
    default: return { error: `unknown event ${ev.type}` };
  }
}

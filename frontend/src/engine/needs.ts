// "I need it now": nearest places open WHEN YOU WOULD ARRIVE, reached by a safety-weighted walk.
// Ranked: confirmed or probably open first (by walking time), then hours not known (listed,
// never claimed open). Closed places are left out.
import { CONFIG } from "../config";
import { type FactView } from "./freshness";
import { combine, edgeCostRisk, edgeRisk, pathComps } from "./risk";
import { openFact, type OpenCache } from "./services";
import type { State } from "./state";
import { shortestPath } from "./world";

export const NEED_TYPES: Record<string, string[]> = {
  medicine: ["pharmacy", "hospital"], pharmacy: ["pharmacy"], hospital: ["hospital", "clinic"], police: ["police"],
  food: ["food", "shop"], atm: ["atm"], fuel: ["fuel"], toilets: ["toilets"], doctor: ["hospital", "clinic"],
  safe: ["police", "hospital", "fuel", "hotel", "pharmacy"],      // where to wait when no way runs (Backup)
  fire: ["fire_station"],
  people: ["pharmacy", "fuel", "hotel"],                             // open places with people (help ladder, last step)
};

export interface NeedResult {
  id: string; name: string; type: string; lat: number; lon: number; phone: string | null; open: FactView;
  distanceM: number; minutes: [number, number, number]; safety: { lo: number; hi: number }; coords: [number, number][]; tier: number;
}

export function needNow(s: State, cache: OpenCache, kind: string, lat: number, lon: number, t = s.now(), limit = 5): NeedResult[] {
  const w = s.world;
  const types = NEED_TYPES[kind] ?? [kind];
  const x = w.proj.x(lon), y = w.proj.y(lat);
  const cands = w.facilities.filter((p) => types.includes(p.type)).map((p) => [p, Math.hypot(p.x - x, p.y - y)] as const)
    .filter(([, d]) => d < 4000).sort((a, b) => a[1] - b[1]).slice(0, 10);
  const er = edgeRisk(s, t, cache);
  const risk = edgeCostRisk(er, w.m);
  const cost = new Float64Array(w.m);
  for (let e = 0; e < w.m; e++) cost[e] = w.elen[e] / 1.25 + 2 * CONFIG.planner.riskCostSPerM * w.elen[e] * risk[e];
  const [o, od] = w.nearestNode(lat, lon);
  const sp = CONFIG.planner.walkSpeed, wf = er.weather.walk;
  const out: NeedResult[] = [];
  for (const [p] of cands) {
    const [d, dd] = w.nearestNode(p.lat, p.lon);
    const path = shortestPath(w, o, d, cost, { blocked: er.walkBlocked });
    if (!path) continue;
    const idx = path.map(([e]) => e);
    const dist = idx.reduce((a, e) => a + w.elen[e], 0) + od + dd;
    const mins: [number, number, number] = [dist / (sp.best * wf[0]) / 60, dist / (sp.expected * wf[1]) / 60, dist / (sp.worst * wf[2]) / 60];
    const f = openFact(s, p, t + mins[1] * 60000);
    const v = s.view(f);
    if (v.value === false && (v.status === "KNOWN" || v.status === "PROBABLE")) continue;      // closed when you get there
    const [lo, hi] = idx.length ? combine(pathComps(er, idx, w.elen)) : [0, 0];
    const tier = v.value === true && (v.status === "KNOWN" || v.status === "PROBABLE") ? 0 : 1;
    out.push({ id: p.id, name: p.name || p.type, type: p.type, lat: p.lat, lon: p.lon, phone: p.phone, open: v, distanceM: Math.round(dist), minutes: mins,
      safety: { lo: Math.round(100 * (1 - hi)), hi: Math.round(100 * (1 - lo)) }, coords: [[lat, lon], ...w.pathCoords(path), [p.lat, p.lon]], tier });
  }
  out.sort((a, b) => a.tier - b.tier || a.minutes[1] * (a.open.status === "PROBABLE" ? 1.2 : 1) - b.minutes[1] * (b.open.status === "PROBABLE" ? 1.2 : 1));
  const seen: NeedResult[] = [];
  for (const r of out) if (!seen.some((q) => q.name === r.name && Math.abs(q.lat - r.lat) < 0.0015 && Math.abs(q.lon - r.lon) < 0.0015)) seen.push(r);
  return seen.slice(0, limit);
}

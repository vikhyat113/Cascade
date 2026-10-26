// Opening-hours facts for places, and the isolation / emergency layers built from
// "what is open around here at time t". Provenance:
//   OSM opening_hours  -> observed, aged by the element's last edit (<=1y KNOWN, <=3y PROBABLE, older OUTDATED)
//   category prior     -> inferred, PROBABLE (police 24/7, hospitals usually 24/7, ...)
//   nothing usable     -> value null -> UNKNOWN (never guessed)
import { SOURCES } from "../config";
import { CODE, type Fact, type FactView, type Status } from "./freshness";
import { isOpen, parseHours } from "./hours";
import type { State } from "./state";
import { clamp } from "./util";
import { ACTIVITY, EMERGENCY, type Poi } from "./world";

const YEAR_S = 365 * 86400;
const SPECIALIST = ["eye", "dental", "skin", "clinic", "maternity", "diagnostic", "dispensary", "paediatric", "glaucoma", "physio", "ivf"];
export const HAVEN = new Set(["hospital", "police", "fuel", "food", "shop", "pharmacy", "fire_station"]);

function prior(p: Poi, hour: number): [boolean, number, string] | null {
  const night = hour >= 21 || hour < 7;
  const name = p.name.toLowerCase();
  switch (p.type) {
    case "hospital":
      if (SPECIALIST.some((w) => name.includes(w))) return night ? [false, 0.5, "specialist centre: usually closed at night (inferred)"] : null;
      return p.emergency ? [true, 0.75, "hospital with emergency department: usually 24/7"] : [true, 0.55, "general hospital: usually admits 24/7 (inferred)"];
    case "police": return [true, 0.7, "police posts are staffed 24/7 (inferred)"];
    case "fire_station": return [true, 0.7, "fire stations are staffed 24/7 (inferred)"];
    case "atm": return [true, 0.5, "ATMs are usually 24/7 (inferred)"];
    case "clinic": case "bank": return night ? [false, 0.6, `${p.type}s are usually closed at night (inferred)`] : null;
    default: return null;        // pharmacy, food, shop, fuel: no reliable prior -> UNKNOWN
  }
}

export function openFact(s: State, p: Poi, t: number): Fact {
  const key = `poi:open:${p.id}`;
  const src = SOURCES.osm_hours;
  const city = s.world.city;
  if (p.hours && s.available("osm_hours")) {
    const oh = parseHours(p.hours);
    if (!oh) return { key, value: null, source: "osm_hours", synthetic: false, observedAt: p.editedAt, ttlS: src.ttlS, reliability: src.reliability, kind: "observed", note: `opening hours "${p.hours}" could not be read` };
    return { key, value: isOpen(oh, city.weekday(t), city.hour(t) * 60 + city.minute(t)), source: "osm_hours", synthetic: false,
      observedAt: p.editedAt ?? s.world.poisAt, ttlS: src.ttlS, reliability: src.reliability, kind: "observed",
      note: `OSM opening_hours "${p.hours}"` };
  }
  const pr = prior(p, city.hour(t));
  if (pr) return { key, value: pr[0], source: "prior", synthetic: false, observedAt: s.world.poisAt, ttlS: YEAR_S, reliability: pr[1], kind: "inferred", note: pr[2] };
  return { key, value: null, source: "osm_hours", synthetic: false, observedAt: s.world.poisAt, ttlS: src.ttlS, reliability: src.reliability, kind: "observed",
    note: p.hours ? "opening hours unavailable (source off)" : "no opening hours in OSM and no reliable prior" };
}

export interface PoiView { id: string; name: string; type: string; lat: number; lon: number; open: FactView; distM: number | null; phone: string | null }

export function poiView(s: State, p: Poi, t: number, distM: number | null = null): PoiView {
  return { id: p.id, name: p.name || p.type, type: p.type, lat: p.lat, lon: p.lon, open: s.view(openFact(s, p, t)), distM: distM === null ? null : Math.round(distM), phone: p.phone };
}

type Item = { p: Poi; f: Fact; st: Status };

/** Open-state of every facility at one time bucket. */
export class OpenLayer {
  items: Item[];
  constructor(s: State, public t: number) {
    this.items = s.world.facilities.map((p) => { const f = openFact(s, p, t); return { p, f, st: s.statusOf(f) }; });
  }
  pick(pred: (it: Item) => boolean): Item[] { return this.items.filter(pred); }
}

const good = (it: Item) => it.f.value === true && (it.st === "KNOWN" || it.st === "PROBABLE");
const maybe = (it: Item) => (it.f.value === true && it.st !== "UNKNOWN") || it.st === "UNKNOWN";

/** Nearest point within NEAREST_CAP_M of every query, via a grid (was brute force: too slow for the
 *  Nagpur + Butibori graph). Beyond the cap: 1e5 / -1. Every user saturates by 3 km (isolation at
 *  ~760 m, emergency at 3000 m), so the cap changes no result. */
const NEAREST_CAP_M = 3500, NEAREST_CELL_M = 500;
export function nearest(xs: Float64Array, ys: Float64Array, pts: Item[]): [Float64Array, Int32Array] {
  const n = xs.length;
  const d = new Float64Array(n).fill(1e5);
  const idx = new Int32Array(n).fill(-1);
  if (!pts.length) return [d, idx];
  const G = NEAREST_CELL_M, CAP = NEAREST_CAP_M;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of pts) { x0 = Math.min(x0, it.p.x); y0 = Math.min(y0, it.p.y); x1 = Math.max(x1, it.p.x); y1 = Math.max(y1, it.p.y); }
  x0 -= CAP; y0 -= CAP; x1 += CAP; y1 += CAP;
  const nx = Math.ceil((x1 - x0) / G) + 1, ny = Math.ceil((y1 - y0) / G) + 1;
  const start = new Int32Array(nx * ny + 1);
  const cellOf = (x: number, y: number) => Math.floor((y - y0) / G) * nx + Math.floor((x - x0) / G);
  for (const it of pts) start[cellOf(it.p.x, it.p.y) + 1]++;
  for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
  const items = new Int32Array(pts.length), fill = start.slice(0, nx * ny);
  pts.forEach((it, k) => { items[fill[cellOf(it.p.x, it.p.y)]++] = k; });
  const R = Math.ceil(CAP / G);
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    const cx = Math.floor((x - x0) / G), cy = Math.floor((y - y0) / G);
    let best = CAP, bi = -1;
    for (let r = 0; r <= R && (r - 1) * G <= best; r++) {
      for (let gy = cy - r; gy <= cy + r; gy++) {
        if (gy < 0 || gy >= ny) continue;
        const edge = gy === cy - r || gy === cy + r;
        for (let gx = cx - r; gx <= cx + r; gx += edge ? 1 : 2 * r || 1) {
          if (gx < 0 || gx >= nx) continue;
          const c = gy * nx + gx;
          for (let j = start[c]; j < start[c + 1]; j++) {
            const k = items[j], dd = Math.hypot(pts[k].p.x - x, pts[k].p.y - y);
            if (dd < best) { best = dd; bi = k; }
          }
        }
      }
    }
    if (bi >= 0) { d[i] = best; idx[i] = bi; }
  }
  return [d, idx];
}

/** Isolation + emergency intervals for every edge (optimistic bound counts UNKNOWN hours as maybe open). */
export class EdgeOpen {
  isoLo: Float32Array; isoHi: Float32Array; isoCode: Uint8Array;
  emLo: Float32Array; emHi: Float32Array; emCode: Uint8Array; emDist: Float64Array; emItem: (Item | null)[];
  constructor(s: State, layer: OpenLayer) {
    const w = s.world;
    const f = (d: number) => clamp((d - 60) / 700, 0, 1);
    const act = layer.pick((it) => ACTIVITY.has(it.p.type));
    const [dOpt] = nearest(w.emx, w.emy, act.filter(maybe));
    const [dPess] = nearest(w.emx, w.emy, act.filter(good));
    const [dKnown] = nearest(w.emx, w.emy, act.filter((it) => it.f.value === true && it.st === "KNOWN"));
    const [dAny] = nearest(w.emx, w.emy, act);
    const em = layer.pick((it) => EMERGENCY.has(it.p.type));
    const [eOpt] = nearest(w.emx, w.emy, em.filter(maybe));
    const emGood = em.filter(good);
    const [ePess, eIdx] = nearest(w.emx, w.emy, emGood);
    const m = w.m;
    this.isoLo = new Float32Array(m); this.isoHi = new Float32Array(m); this.isoCode = new Uint8Array(m);
    this.emLo = new Float32Array(m); this.emHi = new Float32Array(m); this.emCode = new Uint8Array(m); this.emDist = ePess; this.emItem = new Array(m);
    for (let e = 0; e < m; e++) {
      this.isoLo[e] = 0.55 * w.isoBase[e] + 0.45 * f(dOpt[e]);
      this.isoHi[e] = 0.55 * w.isoBase[e] + 0.45 * f(dPess[e]);
      this.isoCode[e] = dKnown[e] <= 300 ? CODE.KNOWN : dPess[e] <= 300 || dAny[e] > 300 ? CODE.PROBABLE : CODE.UNKNOWN;
      this.emLo[e] = clamp(eOpt[e] / 3000, 0, 1);
      this.emHi[e] = clamp(ePess[e] / 3000, 0, 1);
      const it = eIdx[e] >= 0 ? emGood[eIdx[e]] : null;
      this.emItem[e] = it;
      this.emCode[e] = it && ePess[e] <= 3000 ? CODE[it.st] : CODE.UNKNOWN;
    }
  }
}

/** Caches layers per 15-minute bucket (and hours-source availability). */
export class OpenCache {
  private layers = new Map<string, OpenLayer>();
  private edges = new Map<string, EdgeOpen>();
  private key(s: State, t: number): string { return `${Math.floor(t / 900000)}|${s.available("osm_hours")}`; }
  layer(s: State, t: number): OpenLayer {
    const k = this.key(s, t);
    let l = this.layers.get(k);
    if (!l) {
      if (this.layers.size > 16) { this.layers.clear(); this.edges.clear(); }
      l = new OpenLayer(s, Math.floor(t / 900000) * 900000);
      this.layers.set(k, l);
    }
    return l;
  }
  edgesAt(s: State, t: number): EdgeOpen {
    const k = this.key(s, t);
    let e = this.edges.get(k);
    if (!e) { e = new EdgeOpen(s, this.layer(s, t)); this.edges.set(k, e); }
    return e;
  }
  clear() { this.layers.clear(); this.edges.clear(); }
}

export function havensNear(s: State, cache: OpenCache, t: number, x: number, y: number, r: number, limit = 3): PoiView[] {
  return cache.layer(s, t).pick((it) => HAVEN.has(it.p.type) && good(it))
    .map((it) => [it, Math.hypot(it.p.x - x, it.p.y - y)] as const).filter(([, d]) => d <= r)
    .sort((a, b) => a[1] - b[1]).slice(0, limit).map(([it, d]) => poiView(s, it.p, t, d));
}

export function hoursCoverage(s: State, t: number): Record<Status, number> {
  const c: Record<Status, number> = { KNOWN: 0, PROBABLE: 0, OUTDATED: 0, UNKNOWN: 0 };
  for (const p of s.world.facilities) c[s.statusOf(openFact(s, p, t))]++;
  return c;
}

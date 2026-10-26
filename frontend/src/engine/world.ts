// Static world: everything loaded once from the bundled data (src/data/*.json).
import { CONFIG, SOURCES } from "../config";
import { CODE, status, confidence, type Fact, type Status } from "./freshness";
import { CityTime } from "./time";
import { Proj, Rng } from "./util";

// ---- bundle shapes (written by tools/build_data.py) ----------------------------------------------
export interface GraphJson {
  generated_at: string | null; nodes: [number, number][]; hw_codes: string[]; names: string[];
  edges: { u: number[]; v: number[]; len: number[]; hw: number[]; lit: number[]; lamps: number[]; name: number[]; geom: number[][] };
}
export interface PoiJson { id: string; type: string; name: string | null; lat: number; lon: number; opening_hours: string | null; phone: string | null; emergency?: string | null; edited_at: string | null }
export interface PlaceJson { name: string; lat: number; lon: number; kind: string }
export interface WeatherJson { fetched_at: string | null; hourly: Record<string, (number | null)[] | string[] | undefined> & { time: string[] } }
export interface IncidentsJson { grid: { xmin: number; ymin: number; size: number; nx: number; ny: number }; risk: Record<string, number[]> }
export interface RouteJson {
  id: string; name: string; mode: string; color?: string; stops: { id: string; name: string; lat: number; lon: number; est?: boolean }[]; seg_s: number[];
  service: { from: string; to: string; headway_min: number }[]; both_directions?: boolean; note?: string;
  hours_known?: boolean; headway_min?: number | null; source?: "osm" | "manual" | "estimated"; synthetic?: boolean;
}
export interface ScheduleJson { generated_at: string | null; synthetic: boolean; routes: RouteJson[] }
export interface MetaJson {
  city_name: string; center: { lat: number; lon: number }; radius_m: number; tz_offset_min: number; seed: number;
  zones?: Zone[];            // the area is named zones (data/area.geojson); center/radius only enclose them
  ui_defaults: { home: { lat: number; lon: number; name: string }; work: { lat: number; lon: number; name: string }; start: { lat: number; lon: number; name: string }; deadline: string | null };
  generated_at: string; sample: boolean; real: string[]; synthetic: string[];
}
export interface Zone { id: string; name: string; detail: "full" | "major"; ring: [number, number][] }
export interface AreaHit { inside: boolean; distM: number; zone: string | null }

export interface Bundle { graph: GraphJson; pois: PoiJson[]; places: PlaceJson[]; weather: WeatherJson; incidents: IncidentsJson; schedule: ScheduleJson; meta: MetaJson }

export const MAIN = new Set(["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link"]);
const MINOR = new Set(["residential", "unclassified", "living_street", "service", "road"]);
const NO_CARS = new Set(["footway", "path", "pedestrian", "steps", "track", "cycleway", "bridleway", "corridor"]);
const CLASS_ISO: Record<string, number> = { trunk: 0.3, trunk_link: 0.35, primary: 0.15, primary_link: 0.2, secondary: 0.2, secondary_link: 0.25, tertiary: 0.3, tertiary_link: 0.3, residential: 0.45, living_street: 0.4, unclassified: 0.5, service: 0.55, footway: 0.6, path: 0.7, pedestrian: 0.3, track: 0.8, steps: 0.6, cycleway: 0.6, motorway: 0.6, motorway_link: 0.6 };
const CLASS_TRAFFIC_WALK: Record<string, number> = { motorway: 0.6, motorway_link: 0.5, trunk: 0.4, trunk_link: 0.35, primary: 0.3, primary_link: 0.25, secondary: 0.2, secondary_link: 0.2, tertiary: 0.12, tertiary_link: 0.12, footway: 0, path: 0, pedestrian: 0, steps: 0 };
const KPH: Record<string, number> = { motorway: 70, trunk: 55, primary: 45, secondary: 40, tertiary: 35, residential: 25, living_street: 15, service: 15, unclassified: 25 };
export const ACTIVITY = new Set(["hospital", "police", "fire_station", "fuel", "food", "shop", "pharmacy", "clinic", "atm"]);
export const EMERGENCY = new Set(["hospital", "police"]);

export interface Poi { id: string; type: string; name: string; lat: number; lon: number; x: number; y: number; hours: string | null; phone: string | null; emergency: boolean; editedAt: number | null }
export interface Stop { id: string; name: string; lat: number; lon: number; x: number; y: number; est?: boolean }
/** `hoursKnown` false: when the route runs is not known (UNKNOWN), never invented (UPGRADE §5.3). */
export interface Route {
  id: string; name: string; mode: string; color: string; stops: Stop[]; segS: number[]; service: RouteJson["service"]; both: boolean; note: string;
  hoursKnown: boolean; headwayMin: number | null; source: string; synthetic: boolean;
}

export class Grid {
  nx: number; ny: number;
  constructor(public xmin: number, public ymin: number, public size: number, nx?: number, ny?: number, half?: number) {
    this.nx = nx ?? Math.ceil((2 * (half ?? 0)) / size);
    this.ny = ny ?? this.nx;
  }
  get n() { return this.nx * this.ny; }
  index(x: number, y: number): number {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.xmin) / this.size)));
    const j = Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.ymin) / this.size)));
    return j * this.nx + i;
  }
  center(c: number): [number, number] { return [this.xmin + ((c % this.nx) + 0.5) * this.size, this.ymin + (Math.floor(c / this.nx) + 0.5) * this.size]; }
}

export class World {
  meta: MetaJson; proj: Proj; city: CityTime;
  // nodes
  n: number; nlat: Float64Array; nlon: Float64Array; nx: Float64Array; ny: Float64Array;
  adjStart: Int32Array; adjEdge: Int32Array; adjNode: Int32Array;
  // edges
  m: number; eu: Int32Array; ev: Int32Array; elen: Float64Array; ehw: string[]; ename: (string | null)[]; egeom: number[][];
  emx: Float64Array; emy: Float64Array; isMain: Uint8Array; carOk: Uint8Array; ttFree: Float64Array;
  lightLo: Float32Array; lightHi: Float32Array; lightCode: Uint8Array; lightConf: Float32Array;
  // places
  pois: Poi[]; facilities: Poi[]; places: { name: string; norm: string; lat: number; lon: number; kind: string }[];
  // models
  isoBase: Float32Array; walkTraffic: Float32Array; cell: Int32Array; tcell: Int32Array;
  incGrid: Grid; incRisk: Map<number, Float32Array>; tgrid: Grid;
  trafficCells: number[]; trafficBias: Float32Array; floodEdges: number[];
  routes: Map<string, Route>; scheduleGeneratedAt: number | null; scheduleSynthetic: boolean;
  weatherRows: Map<string, Record<string, number | null>>; weatherFetchedAt: number | null;
  mapAt: number; poisAt: number;
  private nodeBuckets = new Map<number, number[]>();
  private bucketM = 150;

  constructor(public bundle: Bundle) {
    const { graph, meta } = bundle;
    this.meta = meta;
    this.proj = new Proj(meta.center.lat, meta.center.lon);
    this.city = new CityTime(meta.tz_offset_min);
    this.mapAt = graph.generated_at ? Date.parse(graph.generated_at) : Date.parse(meta.generated_at);
    this.poisAt = Date.parse(meta.generated_at);

    // nodes + adjacency (the walk graph is undirected)
    this.n = graph.nodes.length;
    this.nlat = new Float64Array(this.n); this.nlon = new Float64Array(this.n);
    this.nx = new Float64Array(this.n); this.ny = new Float64Array(this.n);
    graph.nodes.forEach(([la, lo], i) => {
      this.nlat[i] = la; this.nlon[i] = lo; this.nx[i] = this.proj.x(lo); this.ny[i] = this.proj.y(la);
      const b = this.bucketKey(this.nx[i], this.ny[i]);
      (this.nodeBuckets.get(b) ?? this.nodeBuckets.set(b, []).get(b)!).push(i);
    });
    const E = graph.edges;
    this.m = E.u.length;
    this.eu = Int32Array.from(E.u); this.ev = Int32Array.from(E.v); this.elen = Float64Array.from(E.len, (l) => Math.max(0.5, l));
    this.ehw = E.hw.map((h) => graph.hw_codes[h] ?? "unclassified");
    this.ename = E.name.map((k) => (k >= 0 ? graph.names[k] : null));
    this.egeom = E.geom;
    const deg = new Int32Array(this.n + 1);
    for (let e = 0; e < this.m; e++) { deg[this.eu[e] + 1]++; deg[this.ev[e] + 1]++; }
    for (let i = 0; i < this.n; i++) deg[i + 1] += deg[i];
    this.adjStart = deg;
    this.adjEdge = new Int32Array(2 * this.m); this.adjNode = new Int32Array(2 * this.m);
    const fill = Int32Array.from(deg);
    for (let e = 0; e < this.m; e++) {
      const a = this.eu[e], b = this.ev[e];
      this.adjEdge[fill[a]] = e; this.adjNode[fill[a]++] = b;
      this.adjEdge[fill[b]] = e; this.adjNode[fill[b]++] = a;
    }

    // per-edge static features
    const m = this.m;
    this.emx = new Float64Array(m); this.emy = new Float64Array(m);
    this.isMain = new Uint8Array(m); this.carOk = new Uint8Array(m); this.ttFree = new Float64Array(m);
    this.lightLo = new Float32Array(m); this.lightHi = new Float32Array(m); this.lightCode = new Uint8Array(m); this.lightConf = new Float32Array(m);
    this.isoBase = new Float32Array(m); this.walkTraffic = new Float32Array(m);
    const osm = SOURCES.osm_map;
    const osmFact: Fact = { key: "osm_map", value: "ok", source: "osm_map", synthetic: false, observedAt: this.mapAt, ttlS: osm.ttlS, reliability: osm.reliability, kind: "observed" };
    const priorFact: Fact = { key: "prior:lighting", value: "main roads usually lit", source: "prior", synthetic: false, observedAt: this.mapAt, ttlS: osm.ttlS, reliability: 0.5, kind: "prior" };
    const at = Date.now();
    const osmSt = status(osmFact, at), osmC = confidence(osmFact, at), prSt = status(priorFact, at), prC = confidence(priorFact, at);
    const set = (e: number, lo: number, hi: number, st: Status, c: number) => { this.lightLo[e] = lo; this.lightHi[e] = hi; this.lightCode[e] = CODE[st]; this.lightConf[e] = c; };
    for (let e = 0; e < m; e++) {
      const g = this.egeom[e];
      const k = Math.floor(g.length / 4) * 2;           // middle vertex (flat lat,lon list)
      const mlat = g.length >= 6 ? g[k] : (g[0] + g[g.length - 2]) / 2;
      const mlon = g.length >= 6 ? g[k + 1] : (g[1] + g[g.length - 1]) / 2;
      this.emx[e] = this.proj.x(mlon); this.emy[e] = this.proj.y(mlat);
      const hw = this.ehw[e];
      this.isMain[e] = MAIN.has(hw) ? 1 : 0;
      this.carOk[e] = NO_CARS.has(hw) ? 0 : 1;
      this.ttFree[e] = this.elen[e] / ((KPH[hw.replace("_link", "")] ?? 25) / 3.6);
      const lit = E.lit[e];
      if (lit === 1 || E.lamps[e] >= 1) set(e, 0.05, 0.2, osmSt, osmC);         // mapped lit / lamps nearby
      else if (lit === 0) set(e, 0.8, 1.0, osmSt, osmC);                         // mapped unlit
      else if (MAIN.has(hw)) set(e, 0.15, 0.6, prSt, prC);                       // prior: main roads usually lit
      else if (MINOR.has(hw)) set(e, 0.25, 0.9, "UNKNOWN", 0);                   // no data: wide interval, no value
      else set(e, 0.35, 1.0, "UNKNOWN", 0);
      this.isoBase[e] = CLASS_ISO[hw] ?? 0.45;
      this.walkTraffic[e] = CLASS_TRAFFIC_WALK[hw] ?? 0.05;
    }

    // places
    const pc = (p: PoiJson): Poi => ({ id: p.id, type: p.type, name: p.name || "", lat: p.lat, lon: p.lon, x: this.proj.x(p.lon), y: this.proj.y(p.lat),
      hours: p.opening_hours, phone: p.phone, emergency: p.emergency === "yes", editedAt: p.edited_at ? Date.parse(p.edited_at) : null });
    this.pois = bundle.pois.map(pc);
    this.facilities = this.pois.filter((p) => ACTIVITY.has(p.type) || p.type === "bank" || p.type === "toilets" || p.type === "fire_station");
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    this.places = bundle.places.map((p) => ({ ...p, norm: norm(p.name) }));

    // models
    const ig = bundle.incidents.grid;
    this.incGrid = new Grid(ig.xmin, ig.ymin, ig.size, ig.nx, ig.ny);
    this.incRisk = new Map(Object.entries(bundle.incidents.risk).map(([h, v]) => [Number(h), Float32Array.from(v)]));
    const half = meta.radius_m + 600;
    this.cell = new Int32Array(m); this.tcell = new Int32Array(m);
    this.tgrid = new Grid(-half, -half, CONFIG.risk.trafficCellM, undefined, undefined, half);
    const cells = new Set<number>();
    for (let e = 0; e < m; e++) {
      this.cell[e] = this.incGrid.index(this.emx[e], this.emy[e]);
      this.tcell[e] = this.tgrid.index(this.emx[e], this.emy[e]);
      if (this.carOk[e]) cells.add(this.tcell[e]);
    }
    this.trafficCells = [...cells].sort((a, b) => a - b);
    const rng = new Rng(meta.seed);
    this.trafficBias = Float32Array.from({ length: this.tgrid.n }, () => rng.uniform(0.9, 1.05));
    // a few synthetic waterlogging-prone spots (heavy rain closes them)
    const cand: number[] = []; for (let e = 0; e < m; e++) if (["residential", "tertiary", "secondary", "unclassified"].includes(this.ehw[e])) cand.push(e);
    const seeds = Array.from({ length: Math.min(7, cand.length) }, () => cand[Math.floor(rng.next() * cand.length)]);
    this.floodEdges = [];
    for (let e = 0; e < m; e++) if (seeds.some((s) => Math.hypot(this.emx[e] - this.emx[s], this.emy[e] - this.emy[s]) < 90)) this.floodEdges.push(e);

    // transit
    const sch = bundle.schedule;
    this.scheduleSynthetic = sch.synthetic !== false;
    this.scheduleGeneratedAt = sch.generated_at ? Date.parse(sch.generated_at) : this.poisAt;
    this.routes = new Map();
    for (const r of sch.routes || []) {
      if (!r.stops || r.stops.length < 2 || r.seg_s.length !== r.stops.length - 1) continue;
      const hoursKnown = r.hours_known ?? (r.service?.length ?? 0) > 0;
      this.routes.set(r.id, { id: r.id, name: r.name, mode: r.mode || "bus", color: r.color || "#f59e0b", segS: r.seg_s, service: r.service ?? [], both: r.both_directions !== false, note: r.note || "",
        hoursKnown, headwayMin: r.headway_min ?? r.service?.[0]?.headway_min ?? null, source: r.source ?? "estimated", synthetic: r.synthetic ?? sch.synthetic !== false,
        stops: r.stops.map((s) => ({ ...s, x: this.proj.x(s.lon), y: this.proj.y(s.lat) })) });
    }

    // weather snapshot rows by city-local hour key "YYYY-MM-DDTHH"
    this.weatherFetchedAt = bundle.weather.fetched_at ? Date.parse(bundle.weather.fetched_at) : null;
    this.weatherRows = new Map();
    const H = bundle.weather.hourly;
    (H.time || []).forEach((t, i) => {
      const row: Record<string, number | null> = {};
      for (const [k, arr] of Object.entries(H)) if (k !== "time" && Array.isArray(arr)) row[k] = (arr[i] as number | null) ?? null;
      this.weatherRows.set(String(t).slice(0, 13), row);
    });
  }

  // ---- spatial helpers ---------------------------------------------------------------------------
  private bucketKey(x: number, y: number): number { return Math.floor(x / this.bucketM) * 100000 + Math.floor(y / this.bucketM); }

  /** Nearest node (optionally one a car can use). Returns [node, distance m]. */
  nearestNode(lat: number, lon: number, carOnly = false): [number, number] {
    const x = this.proj.x(lon), y = this.proj.y(lat);
    const ok = (k: number) => !carOnly || this.nodeHasCar(k);
    let best = -1, bd = Infinity;
    const bx = Math.floor(x / this.bucketM), by = Math.floor(y / this.bucketM);
    for (let r = 0; r < 60 && best < 0; r++) {                 // grow the search ring until found
      for (const rr of [r, r + 1]) {                             // +1 ring: safe at bucket borders
        for (let i = bx - rr; i <= bx + rr; i++) for (let j = by - rr; j <= by + rr; j++) {
          if (Math.max(Math.abs(i - bx), Math.abs(j - by)) !== rr) continue;
          for (const k of this.nodeBuckets.get(i * 100000 + j) ?? []) {
            if (!ok(k)) continue;
            const d = Math.hypot(this.nx[k] - x, this.ny[k] - y);
            if (d < bd) { bd = d; best = k; }
          }
        }
        if (best < 0) break;
      }
    }
    return [best, bd];
  }

  nodeHasCar(k: number): boolean {
    for (let a = this.adjStart[k]; a < this.adjStart[k + 1]; a++) if (this.carOk[this.adjEdge[a]]) return true;
    return false;
  }

  nearestEdge(lat: number, lon: number): number {
    const [node] = this.nearestNode(lat, lon);
    let best = this.adjEdge[this.adjStart[node]] ?? 0, bd = Infinity;
    const x = this.proj.x(lon), y = this.proj.y(lat);
    for (let k = this.adjStart[node]; k < this.adjStart[node + 1]; k++) {
      const e = this.adjEdge[k];
      const d = Math.hypot(this.emx[e] - x, this.emy[e] - y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  /** [lat, lon] points of a path of (edge, reversed) pairs. */
  pathCoords(path: [number, boolean][]): [number, number][] {
    const out: [number, number][] = [];
    for (const [e, rev] of path) {
      const g = this.egeom[e];
      const pts: [number, number][] = [];
      for (let i = 0; i < g.length; i += 2) pts.push([g[i], g[i + 1]]);
      if (out.length) {
        // orient by whichever end touches the previous piece (geometry order is not guaranteed u->v)
        const [la, lo] = out[out.length - 1];
        const d0 = Math.hypot(pts[0][0] - la, pts[0][1] - lo), d1 = Math.hypot(pts[pts.length - 1][0] - la, pts[pts.length - 1][1] - lo);
        if (d1 < d0) pts.reverse();
        out.push(...pts.slice(1));
      } else {
        if (rev) pts.reverse();
        out.push(...pts);
      }
    }
    return out;
  }

  inArea(lat: number, lon: number): boolean { return this.areaHit(lat, lon).distM <= CONFIG.area.nearM; }

  /** Inside a zone (distance 0), else how far to the nearest zone edge. No zones: the old circle. */
  areaHit(lat: number, lon: number): AreaHit {
    const zones = this.meta.zones ?? [];
    const x = this.proj.x(lon), y = this.proj.y(lat);
    if (!zones.length) {
      const d = Math.max(0, Math.hypot(x, y) - this.meta.radius_m);
      return { inside: d === 0, distM: d, zone: null };
    }
    let best: AreaHit = { inside: false, distM: Infinity, zone: null };
    for (const z of zones) {
      const pts = z.ring.map(([la, lo]) => [this.proj.x(lo), this.proj.y(la)] as const);
      let inside = false, d = Infinity;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        const dx = xj - xi, dy = yj - yi, L2 = dx * dx + dy * dy;
        const k = L2 ? Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / L2)) : 0;
        d = Math.min(d, Math.hypot(x - xi - k * dx, y - yi - k * dy));
      }
      if (inside) return { inside: true, distM: 0, zone: z.name };
      if (d < best.distM) best = { inside: false, distM: d, zone: z.name };
    }
    return best;
  }

  /** [south, west, north, east] around every zone (map pan limit). */
  bbox(): [number, number, number, number] {
    const pts = (this.meta.zones ?? []).flatMap((z) => z.ring);
    if (!pts.length) {
      const dLat = this.meta.radius_m / 110540, dLon = this.meta.radius_m / (111320 * Math.cos((this.meta.center.lat * Math.PI) / 180));
      return [this.meta.center.lat - dLat, this.meta.center.lon - dLon, this.meta.center.lat + dLat, this.meta.center.lon + dLon];
    }
    return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  }

  // ---- offline search -----------------------------------------------------------------------------
  geocode(q: string, limit = 6): { name: string; lat: number; lon: number; kind: string }[] {
    const nq = q.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    if (nq.length < 2) return [];
    const nums = nq.match(/\d+/g) ?? [];
    const scored: [number, (typeof this.places)[number]][] = [];
    for (const p of this.places) {
      if (nums.length && !nums.every((n) => (p.norm.match(/\d+/g) ?? ([] as string[])).includes(n))) continue;  // "plot 12" must never become "plot 18"
      let s = p.norm === nq ? 3 : p.norm.startsWith(nq) ? 2.2 : p.norm.includes(nq) ? 1.8 : 0;
      if (!s) { const words = nq.split(" "); s = words.every((w) => p.norm.includes(w)) ? 1.4 : 0; }
      if (!s) continue;
      s += ({ area: 0.3, stop: 0.15, poi: 0.1, street: 0 } as Record<string, number>)[p.kind] ?? 0;
      scored.push([s, p]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const seen = new Set<string>();
    const out = [];
    for (const [, p] of scored) {
      const k = `${p.name}|${p.lat.toFixed(3)}|${p.lon.toFixed(3)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ name: p.name, lat: p.lat, lon: p.lon, kind: p.kind });
      if (out.length >= limit) break;
    }
    return out;
  }

  nearestPlaceName(lat: number, lon: number, maxM = 400): string | null {
    const x = this.proj.x(lon), y = this.proj.y(lat);
    let best: string | null = null, bd = maxM;
    for (const p of this.places) {
      const d = Math.hypot(this.proj.x(p.lon) - x, this.proj.y(p.lat) - y);
      if (d < bd) { bd = d; best = p.name; }
    }
    return best;
  }
}

// ---- shortest path: Dijkstra with a binary heap -------------------------------------------------------
class Heap {
  private k: number[] = []; private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop(): [number, number] {
    const k = this.k, v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

/** Cheapest path from src to dst (edge costs per edge; blocked edges skipped). Returns [edge, reversed][] or null. */
export function shortestPath(w: World, src: number, dst: number, cost: Float64Array, opts: { blocked?: Uint8Array; carOnly?: boolean } = {}): [number, boolean][] | null {
  if (src === dst) return [];
  const dist = new Float64Array(w.n).fill(Infinity);
  const prevEdge = new Int32Array(w.n).fill(-1);
  const done = new Uint8Array(w.n);
  dist[src] = 0;
  const h = new Heap();
  h.push(0, src);
  while (h.size) {
    const [d, u] = h.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === dst) break;
    for (let k = w.adjStart[u]; k < w.adjStart[u + 1]; k++) {
      const e = w.adjEdge[k];
      if (opts.blocked?.[e] || (opts.carOnly && !w.carOk[e])) continue;
      const v = w.adjNode[k];
      const nd = d + Math.max(0.01, cost[e]);
      if (nd < dist[v]) { dist[v] = nd; prevEdge[v] = e; h.push(nd, v); }
    }
  }
  if (!isFinite(dist[dst])) return null;
  const out: [number, boolean][] = [];
  let cur = dst;
  while (cur !== src) {
    const e = prevEdge[cur];
    if (e < 0) return null;
    const from = w.eu[e] === cur ? w.ev[e] : w.eu[e];
    out.push([e, w.eu[e] !== from]);          // reversed when walking v -> u
    cur = from;
  }
  return out.reverse();
}

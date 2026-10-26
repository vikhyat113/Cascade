// HERE online extras (UPGRADE §9): night map tiles, live traffic flow, a public-transit cross-check.
// All optional: no key, an error, or no signal -> the app falls back (OSM tiles, then the bundled roads;
// simulated traffic, labelled as such). The key comes from frontend/.env.local (VITE_HERE_API_KEY, git-ignored);
// it ends up inside the APK, so restrict it in the HERE console. Tiles are never bulk-downloaded or cached
// for offline use (HERE terms): offline the map draws the bundled roads.
import { useEffect, useState } from "react";
import { CONFIG } from "../config";
import { call } from "./engine";

const KEY = (import.meta.env.VITE_HERE_API_KEY ?? "").trim();
export const hereKey = (): string | null => (KEY.length >= 20 ? KEY : null);

export type HereProduct = "tiles" | "traffic" | "transit";
export interface HereStats {
  requests: Record<HereProduct, number>; errors: Record<HereProduct, number>; cached: number;
  traffic: { state: "off" | "live" | "no_coverage" | "denied" | "failed"; segments: number; at: number | null };
  tiles: "off" | "ok" | "failed";
  basemap: "here" | "osm" | "roads";
  tileTest: TileTest;
}
/** Demo: make tiles fail on purpose to show the fallback HERE -> OSM -> bundled roads. */
export type TileTest = "normal" | "here_fails" | "all_fail";
const stats: HereStats = {
  requests: { tiles: 0, traffic: 0, transit: 0 }, errors: { tiles: 0, traffic: 0, transit: 0 }, cached: 0,
  traffic: { state: "off", segments: 0, at: null }, tiles: "off", basemap: "roads", tileTest: "normal",
};
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());
export const hereStats = () => stats;
export function useHereStats(): HereStats {
  const [, bump] = useState(0);
  useEffect(() => { const f = () => bump((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return stats;
}
/** Called by the map for every HERE tile request and failure (counted, not cached by us). */
export function countTile(ok: boolean | null) {
  if (stats.tileTest !== "normal") return;                 // Demo tile test: those requests never reach HERE
  if (ok === null) stats.requests.tiles++;
  else if (ok) { if (stats.tiles === "ok") return; stats.tiles = "ok"; }
  else { stats.errors.tiles++; stats.tiles = "failed"; }
  changed();
}
export function setBasemap(b: HereStats["basemap"]) { if (stats.basemap !== b) { stats.basemap = b; changed(); } }

const tileSubs = new Set<() => void>();
export function setTileTest(t: TileTest) { stats.tileTest = t; tileSubs.forEach((f) => f()); changed(); }
export function onTileTest(f: () => void) { tileSubs.add(f); return () => { tileSubs.delete(f); }; }

export interface TileSource { id: "here" | "osm"; url: string; attribution: string; className: string }
/** Online basemaps in the order to try them. The bundled roads come after the last one. */
export function tileChain(): TileSource[] {
  const BAD = "https://tiles.invalid/{z}/{x}/{y}.png";                 // Demo tile test: fails at once
  const out: TileSource[] = [];
  const here = hereTileUrl();
  if (here) out.push({ id: "here", url: stats.tileTest !== "normal" ? BAD : here, attribution: `© ${new Date().getFullYear()} HERE`, className: "nw-tiles-here" });
  out.push({ id: "osm", url: stats.tileTest === "all_fail" ? BAD : CONFIG.map.tileUrl,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', className: "nw-tiles" });
  return out;
}

/** HERE Raster Tile API v3, night style. Null when there is no key (the map uses OSM). */
export function hereTileUrl(): string | null {
  const k = hereKey();
  if (!k || CONFIG.map.provider !== "here") return null;
  const h = CONFIG.here;
  return `${h.tileUrl}?style=${h.tileStyle}&size=256&lang=en&apiKey=${encodeURIComponent(k)}`;
}

// ---- requests: throttled, cached in memory for a few minutes ------------------------------------------
const cache = new Map<string, { at: number; value: unknown }>();
const lastCall: Partial<Record<HereProduct, number>> = {};

class HereError extends Error { constructor(public status: number) { super(`HERE answered ${status}`); } }

async function get<T>(product: HereProduct, url: string): Promise<T> {
  const k = hereKey();
  if (!k) throw new HereError(0);
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CONFIG.here.cacheS * 1000) { stats.cached++; changed(); return hit.value as T; }
  const gap = CONFIG.here.minGapS[product] * 1000, last = lastCall[product] ?? 0;
  if (Date.now() - last < gap) throw new Error("throttled");
  lastCall[product] = Date.now();
  stats.requests[product]++; changed();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(`${url}&apiKey=${encodeURIComponent(k)}`, { signal: ctl.signal });
    if (!r.ok) throw new HereError(r.status);
    const value = (await r.json()) as T;
    cache.set(url, { at: Date.now(), value });
    return value;
  } catch (e) { stats.errors[product]++; changed(); throw e; }
  finally { clearTimeout(timer); }
}

// ---- traffic flow -> engine (real "traffic" source while it answers) -----------------------------------
interface FlowJson {
  sourceUpdated?: string;
  results?: { location?: { shape?: { links?: { points?: { lat: number; lng: number }[] }[] } };
    currentFlow?: { speed?: number; freeFlow?: number; traversability?: string; confidence?: number } }[];
}

/** One sample per HERE road piece: its middle point and current / free-flow speed. */
export function flowSamples(j: FlowJson): { lat: number; lon: number; f: number }[] {
  const out: { lat: number; lon: number; f: number }[] = [];
  for (const r of j.results ?? []) {
    const cf = r.currentFlow;
    if (!cf) continue;
    const f = cf.traversability === "closed" ? 0.1 : cf.speed && cf.freeFlow ? Math.min(1.2, Math.max(0.1, cf.speed / cf.freeFlow)) : NaN;
    if (!isFinite(f)) continue;
    for (const l of r.location?.shape?.links ?? []) {
      const p = l.points ?? [];
      if (p.length) out.push({ lat: p[p.length >> 1].lat, lon: p[p.length >> 1].lng, f: Math.round(f * 1000) / 1000 });
    }
  }
  return out;
}

async function pullTraffic(bbox: [number, number, number, number]) {
  const [s, w, n, e] = bbox.map((v) => Math.round(v * 1e4) / 1e4);
  try {
    const j = await get<FlowJson>("traffic", `${CONFIG.here.flowUrl}?in=bbox:${w},${s},${e},${n}&locationReferencing=shape`);
    const pts = flowSamples(j);
    if (!pts.length) { stats.traffic = { state: "no_coverage", segments: 0, at: null }; changed(); return; }
    const at = j.sourceUpdated ? Date.parse(j.sourceUpdated) : Date.now();
    const cells = await call("setRealTraffic", pts, isFinite(at) ? at : Date.now());
    stats.traffic = { state: "live", segments: pts.length, at: Date.now() }; changed();
    return cells;
  } catch (e) {
    if ((e as Error).message === "throttled") return;
    const st = e instanceof HereError ? e.status : -1;
    stats.traffic = { ...stats.traffic, state: st === 401 || st === 403 ? "denied" : "failed" }; changed();
  }
}

/** Polls HERE traffic flow for the area while online and a key exists. Stops (and the facts age) otherwise. */
export function useHereTraffic(bbox: [number, number, number, number] | null) {
  useEffect(() => {
    if (!bbox || !hereKey() || !CONFIG.here.traffic) return;
    const run = () => { if (navigator.onLine && stats.traffic.state !== "denied" && stats.traffic.state !== "no_coverage") void pullTraffic(bbox); };
    run();
    const id = window.setInterval(run, CONFIG.here.trafficEveryS * 1000);
    return () => window.clearInterval(id);
  }, [bbox?.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ---- public transit cross-check (Demo drawer only, never used for planning) -----------------------------
interface TransitJson {
  routes?: { sections?: { type: string; departure?: { time?: string }; arrival?: { time?: string };
    transport?: { mode?: string; name?: string; headsign?: string } }[] }[];
  notices?: { code?: string; title?: string }[];
}
export interface TransitCheck { ok: boolean; text: string; ways: string[] }

export async function hereTransitCheck(from: { lat: number; lon: number }, to: { lat: number; lon: number }): Promise<TransitCheck> {
  if (!hereKey()) return { ok: false, text: "No HERE key (frontend/.env.local).", ways: [] };
  try {
    const j = await get<TransitJson>("transit",
      `${CONFIG.here.transitUrl}?origin=${from.lat.toFixed(5)},${from.lon.toFixed(5)}&destination=${to.lat.toFixed(5)},${to.lon.toFixed(5)}&alternatives=2`);
    const ways = (j.routes ?? []).map((r) => (r.sections ?? []).map((s) => {
      const min = s.departure?.time && s.arrival?.time ? Math.round((Date.parse(s.arrival.time) - Date.parse(s.departure.time)) / 60000) : null;
      const what = s.type === "pedestrian" ? "walk" : `${s.transport?.mode ?? s.type} ${s.transport?.name ?? ""}`.trim();
      return `${what}${min !== null ? ` ${min} min` : ""}`;
    }).join(" → "));
    const transit = ways.filter((w) => !/^walk( \d+ min)?$/.test(w));
    if (!transit.length) return { ok: true, text: `no HERE transit data here${j.notices?.length ? ` (${j.notices.map((n) => n.code).join(", ")})` : ""}`, ways };
    return { ok: true, text: `HERE found ${transit.length} way(s) with public transport`, ways };
  } catch (e) {
    if ((e as Error).message === "throttled") return { ok: false, text: "Wait a few seconds (requests are throttled).", ways: [] };
    return { ok: false, text: `HERE transit failed: ${(e as Error).message}`, ways: [] };
  }
}

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { useT } from "../copy";
import { CONFIG } from "../config";
import { call } from "../lib/engine";
import { THEME } from "../theme";
import type { LatLon, PlaceOnWay } from "../types";
import { PLACE_ICON } from "./icons";

/** What the map layers draw (UPGRADE §3). Each is null while off. */
export interface MapLayers {
  lit?: { lit: { pts: Float32Array; off: Uint32Array }; dark: { pts: Float32Array; off: Uint32Array } } | null;
  heat?: { cells: number[][]; strength: number } | null;
  help?: { lat: number; lon: number; type: string; name: string; state: "open" | "maybe_open" | "not_sure" | "closed" }[] | null;
  weather?: { lat: number; lon: number; temp: number | null; rain: number | null }[] | null;
  night?: { url: string; bounds: [[number, number], [number, number]]; strength: number } | null;
}

type Props = {
  layers?: MapLayers;
  center: { lat: number; lon: number };
  bbox: [number, number, number, number];   // [south, west, north, east] of the zones the app has data for
  path?: LatLon[] | null;
  start?: LatLon | null;
  end?: LatLon | null;
  me?: LatLon | null;
  changes?: LatLon[];       // stops where the way changes bus / metro
  places?: PlaceOnWay[];
  fitKey?: string;
  bottomPad: number;
  topPad?: number;          // room for cards over the top of the map (pill, next step)
  onPick?: ((lat: number, lon: number) => void) | null;
};

const C = THEME.color;
const ACCENT = C.accent;

function pinIcon(): L.DivIcon {
  return L.divIcon({
    className: "", iconSize: [30, 38], iconAnchor: [15, 36],
    html: `<svg width="30" height="38" viewBox="0 0 30 38" aria-hidden="true"><path d="M15 37s13-12.6 13-22A13 13 0 0 0 2 15c0 9.4 13 22 13 22z" fill="${ACCENT}" stroke="${C.ink}" stroke-width="2.5"/><circle cx="15" cy="15" r="5" fill="${C.ink}"/></svg>`,
  });
}

function placeIcon(p: PlaceOnWay): L.DivIcon {
  const ring = p.state === "open" ? C.good : p.state === "maybe_open" ? C.warn : C.soft;
  return L.divIcon({
    className: "", iconSize: [34, 34], iconAnchor: [17, 17],
    html: `<div style="width:34px;height:34px;border-radius:50%;background:${C.surface};border:3px solid ${ring};display:flex;align-items:center;justify-content:center;font-size:17px">${PLACE_ICON[p.type] || "📍"}</div>`,
  });
}

/** Mix two #rrggbb colours (k 0..1). */
function mix(a: string, b: string, k: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * k)).join(",")})`;
}

/** Unpack the worker's flat road arrays into Leaflet polylines. */
function lines(pts: Float32Array, off: Uint32Array): LatLon[][] {
  const out: LatLon[][] = [];
  for (let i = 0; i + 1 < off.length; i++) {
    const l: LatLon[] = [];
    for (let k = off[i]; k < off[i + 1]; k += 2) l.push([pts[k], pts[k + 1]]);
    if (l.length > 1) out.push(l);
  }
  return out;
}

/** Dark street map: OpenStreetMap tiles in a night palette when online. The road network bundled in
 *  the app (major roads brighter) is drawn until tiles load and whenever they can't (offline). */
export function MapCanvas({ center, bbox, layers, path, start, end, me, changes, places, fitKey, bottomPad, topPad = 80, onPick }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const extra = useRef<L.LayerGroup | null>(null);
  const extraRenderer = useRef<L.Canvas | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const { t } = useT();

  useEffect(() => {
    if (!box.current) return;
    // keep the map near the zones the app has data for (roads, places): no panning off into nothing
    const pad = CONFIG.map.boundsPadM, dLat = pad / 110540, dLon = pad / (111320 * Math.cos((center.lat * Math.PI) / 180));
    const bounds = L.latLngBounds([bbox[0] - dLat, bbox[1] - dLon], [bbox[2] + dLat, bbox[3] + dLon]);
    const m = L.map(box.current, { zoomControl: false, attributionControl: false, preferCanvas: true, minZoom: 12, maxZoom: CONFIG.map.maxZoom,
      maxBounds: bounds, maxBoundsViscosity: 0.9 })
      .setView([center.lat, center.lon], 14);
    // the OpenStreetMap credit must stay visible: top-left under the status pill (SOS owns the top-right,
    // the sheets cover the bottom)
    L.control.attribution({ position: "topleft", prefix: false }).addTo(m);
    const tiles = L.tileLayer(CONFIG.map.tileUrl, {
      className: "nw-tiles", maxZoom: CONFIG.map.maxZoom,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m);

    // bundled roads: shown until tiles load, and again when tiles fail or the phone goes offline
    m.createPane("roads").style.zIndex = "350";             // above tiles, below the way, pins and dots (overlayPane is 400)
    const renderer = L.canvas({ padding: 0.3, pane: "roads" });
    const roads = L.layerGroup();
    // one map or the other, never both: street tiles when they load, else only our roads
    let tilesOk = false, errors = 0, shown: boolean | null = null;
    const sync = () => {
      const useTiles = tilesOk && navigator.onLine;
      if (useTiles === shown) return;
      shown = useTiles;
      tiles.setOpacity(useTiles ? 1 : 0);
      if (useTiles) roads.remove(); else roads.addTo(m);
    };
    tiles.on("tileload", () => { errors = 0; tilesOk = true; sync(); });
    tiles.on("tileerror", () => { if (++errors >= CONFIG.map.tileErrorsBeforeRoads) { tilesOk = false; sync(); } });
    const online = () => { errors = 0; tiles.redraw(); sync(); };     // signal back: try the tiles again
    window.addEventListener("online", online);
    window.addEventListener("offline", sync);
    sync();
    let stop = false;
    call("roads").then((r) => {
      if (stop) return;
      L.polyline(lines(r.minor, r.minorOff), { renderer, color: C.roadMinor, weight: 1.5, opacity: 1, interactive: false, smoothFactor: 1.5 }).addTo(roads);
      L.polyline(lines(r.major, r.majorOff), { renderer, color: C.roadMajor, weight: 3, opacity: 1, interactive: false, smoothFactor: 1.5 }).addTo(roads);
    }).catch(() => {});
    layer.current = L.layerGroup().addTo(m);
    m.createPane("layers").style.zIndex = "360";            // map layers: above the roads, below the way and pins
    extraRenderer.current = L.canvas({ padding: 0.3, pane: "layers" });
    extra.current = L.layerGroup().addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => pickRef.current?.(e.latlng.lat, e.latlng.lng));
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(box.current);
    return () => {
      stop = true; ro.disconnect(); m.remove(); map.current = null;
      window.removeEventListener("online", online); window.removeEventListener("offline", sync);
    };
  }, [center.lat, center.lon, ...bbox]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- map layers ----
  useEffect(() => {
    const g = extra.current, renderer = extraRenderer.current;
    if (!g || !renderer) return;
    g.clearLayers();
    const L_ = layers ?? {};
    if (L_.night) L.imageOverlay(L_.night.url, L_.night.bounds, { pane: "layers", opacity: L_.night.strength, interactive: false }).addTo(g);
    if (L_.heat?.cells.length) {
      const vs = L_.heat.cells.map((c) => c[4]), lo = Math.min(...vs), hi = Math.max(...vs);
      const col = (v: number) => { const k = hi > lo ? (v - lo) / (hi - lo) : 0.5; return k < 0.5 ? mix(C.good, C.warn, k * 2) : mix(C.warn, C.bad, (k - 0.5) * 2); };
      for (const [s, w, n, e, v] of L_.heat.cells)
        L.rectangle([[s, w], [n, e]], { renderer, stroke: false, fillColor: col(v), fillOpacity: L_.heat.strength * 0.75, interactive: false }).addTo(g);
    }
    if (L_.lit) {
      L.polyline(lines(L_.lit.dark.pts, L_.lit.dark.off), { renderer, color: C.bad, weight: 4, opacity: 0.9, interactive: false }).addTo(g);
      L.polyline(lines(L_.lit.lit.pts, L_.lit.lit.off), { renderer, color: C.warn, weight: 5, opacity: 1, interactive: false }).addTo(g);
    }
    for (const p of L_.help ?? []) {
      const ring = p.state === "open" ? C.good : p.state === "maybe_open" ? C.warn : p.state === "closed" ? C.bad : C.soft;
      L.marker([p.lat, p.lon], { pane: "layers", keyboard: false, title: p.name, icon: L.divIcon({ className: "", iconSize: [26, 26], iconAnchor: [13, 13],
        html: `<div style="width:26px;height:26px;border-radius:50%;background:${C.surface};border:3px ${p.state === "not_sure" ? "dashed" : "solid"} ${ring};opacity:${p.state === "closed" ? 0.55 : 1};display:flex;align-items:center;justify-content:center;font-size:13px">${PLACE_ICON[p.type] || "📍"}</div>` }) }).addTo(g);
    }
    for (const p of L_.weather ?? []) {
      L.marker([p.lat, p.lon], { pane: "layers", keyboard: false, interactive: false, icon: L.divIcon({ className: "", iconSize: [54, 24], iconAnchor: [27, 12],
        html: `<div style="background:${C.surface};border:1px solid ${C.edge};border-radius:12px;color:${C.ink};font:600 12px/22px ${THEME.font};text-align:center">${p.temp === null ? "?" : Math.round(p.temp) + "°"}${p.rain !== null && p.rain >= 40 ? " 💧" : ""}</div>` }) }).addTo(g);
    }
  }, [layers]);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    if (path && path.length > 1) {
      L.polyline(path, { color: C.night, weight: 11, opacity: 0.85, interactive: false }).addTo(g);
      L.polyline(path, { color: ACCENT, weight: 6, opacity: 1, interactive: false }).addTo(g);
    }
    if (start) L.circleMarker(start, { radius: 8, color: ACCENT, weight: 4, fillColor: C.ink, fillOpacity: 1 }).addTo(g);
    for (const c of changes ?? []) L.circleMarker(c, { radius: 7, color: C.ink, weight: 3, fillColor: C.warn, fillOpacity: 1, interactive: false }).addTo(g);
    if (end) L.marker(end, { icon: pinIcon(), keyboard: false }).addTo(g);
    (places || []).forEach((p) => L.marker([p.lat, p.lon], { icon: placeIcon(p), title: p.name, alt: p.name }).addTo(g));
    if (me) L.marker(me, { icon: L.divIcon({ className: "", html: '<div class="nw-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(g);
  }, [path, start, end, me, places, changes]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const pts: LatLon[] = [...(path || []), ...(places || []).map((p) => [p.lat, p.lon] as LatLon)];
    if (start) pts.push(start);
    if (end) pts.push(end);
    if (pts.length === 0) return;
    if (pts.length === 1) { m.setView(pts[0], 15); return; }
    m.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [28, topPad], paddingBottomRight: [28, bottomPad + 24], maxZoom: 16 });
    // also re-fit when the sheet settles to its new height (a new screen measures its sheet after the first paint)
  }, [fitKey, Math.round(bottomPad / 40), topPad]); // eslint-disable-line react-hooks/exhaustive-deps

  // `isolate` + z-0: Leaflet panes use z-index 400+; keep them below the sheet, pill and banner.
  return <div ref={box} className="absolute inset-0 isolate z-0" style={{ cursor: onPick ? "crosshair" : undefined }} role="img" aria-label={t("label.map")} />;
}

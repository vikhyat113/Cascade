import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { useT } from "../copy";
import { CONFIG } from "../config";
import { call } from "../lib/engine";
import { THEME } from "../theme";
import type { LatLon, PlaceOnWay } from "../types";
import { PLACE_ICON } from "./icons";

type Props = {
  center: { lat: number; lon: number };
  bbox: [number, number, number, number];   // [south, west, north, east] of the zones the app has data for
  path?: LatLon[] | null;
  start?: LatLon | null;
  end?: LatLon | null;
  me?: LatLon | null;
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
export function MapCanvas({ center, bbox, path, start, end, me, places, fitKey, bottomPad, topPad = 80, onPick }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
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
    // the OpenStreetMap credit must stay visible: top-right, above the sheets (bottom-right is always covered)
    L.control.attribution({ position: "topright", prefix: false }).addTo(m);
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
    m.on("click", (e: L.LeafletMouseEvent) => pickRef.current?.(e.latlng.lat, e.latlng.lng));
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(box.current);
    return () => {
      stop = true; ro.disconnect(); m.remove(); map.current = null;
      window.removeEventListener("online", online); window.removeEventListener("offline", sync);
    };
  }, [center.lat, center.lon, ...bbox]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (end) L.marker(end, { icon: pinIcon(), keyboard: false }).addTo(g);
    (places || []).forEach((p) => L.marker([p.lat, p.lon], { icon: placeIcon(p), title: p.name, alt: p.name }).addTo(g));
    if (me) L.marker(me, { icon: L.divIcon({ className: "", html: '<div class="nw-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(g);
  }, [path, start, end, me, places]);

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

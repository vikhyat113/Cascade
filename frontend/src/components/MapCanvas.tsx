import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { api } from "../api";
import type { LatLon, PlaceOnWay } from "../types";
import { PLACE_ICON } from "./icons";

type Props = {
  center: { lat: number; lon: number };
  path?: LatLon[] | null;
  start?: LatLon | null;
  end?: LatLon | null;
  me?: LatLon | null;
  places?: PlaceOnWay[];
  fitKey?: string;
  bottomPad: number;
  offline: boolean;
  onPick?: ((lat: number, lon: number) => void) | null;
};

const ACCENT = "#8b7cff";

function pinIcon(): L.DivIcon {
  return L.divIcon({
    className: "", iconSize: [30, 38], iconAnchor: [15, 36],
    html: `<svg width="30" height="38" viewBox="0 0 30 38" aria-hidden="true"><path d="M15 37s13-12.6 13-22A13 13 0 0 0 2 15c0 9.4 13 22 13 22z" fill="${ACCENT}" stroke="#fff" stroke-width="2.5"/><circle cx="15" cy="15" r="5" fill="#fff"/></svg>`,
  });
}

function placeIcon(p: PlaceOnWay): L.DivIcon {
  const ring = p.state === "open" ? "#34d399" : p.state === "maybe_open" ? "#fbbf24" : "#c3cae6";
  return L.divIcon({
    className: "", iconSize: [34, 34], iconAnchor: [17, 17],
    html: `<div style="width:34px;height:34px;border-radius:50%;background:#131b31;border:3px solid ${ring};display:flex;align-items:center;justify-content:center;font-size:17px">${PLACE_ICON[p.type] || "📍"}</div>`,
  });
}

export function MapCanvas({ center, path, start, end, me, places, fitKey, bottomPad, offline, onPick }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const streets = useRef<L.GeoJSON | null>(null);
  const tileErrors = useRef(0);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    if (!box.current) return;
    const m = L.map(box.current, { zoomControl: false, attributionControl: true, preferCanvas: true })
      .setView([center.lat, center.lon], 14);
    m.attributionControl.setPrefix(false);
    const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      className: "nw-tiles", maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m);
    tiles.on("tileerror", () => { tileErrors.current += 1; if (tileErrors.current === 4) showStreets(); });
    layer.current = L.layerGroup().addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => pickRef.current?.(e.latlng.lat, e.latlng.lng));
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(box.current);
    return () => { ro.disconnect(); m.remove(); map.current = null; };
  }, [center.lat, center.lon]);

  // Offline base map: our own cached main streets, drawn only when tiles can't load.
  function showStreets() {
    if (streets.current || !map.current) return;
    api.streetsMain().then((fc) => {
      if (!map.current || streets.current) return;
      streets.current = L.geoJSON(fc, { style: { color: "#3a4874", weight: 2, opacity: 0.9 }, interactive: false })
        .addTo(map.current);
      streets.current.bringToBack();
    }).catch(() => {});
  }
  useEffect(() => { if (offline) showStreets(); }, [offline]);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    if (path && path.length > 1) {
      L.polyline(path, { color: "#0a0f1e", weight: 11, opacity: 0.85, interactive: false }).addTo(g);
      L.polyline(path, { color: ACCENT, weight: 6, opacity: 1, interactive: false }).addTo(g);
    }
    if (start) L.circleMarker(start, { radius: 8, color: ACCENT, weight: 4, fillColor: "#fff", fillOpacity: 1 }).addTo(g);
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
    m.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [28, 80], paddingBottomRight: [28, bottomPad + 24], maxZoom: 16 });
  }, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // `isolate` + z-0: Leaflet panes use z-index 400+; keep them below the sheet, pill and banner.
  return <div ref={box} className="absolute inset-0 isolate z-0" style={{ cursor: onPick ? "crosshair" : undefined }} role="img" aria-label="map" />;
}

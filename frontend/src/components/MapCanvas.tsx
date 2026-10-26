import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { FacilityCategory, FacilityPOI, HoursTier, LatLon, Place, PlaceOnWay } from "../types";
import type { LayerState } from "./LayerPanel";
import { PLACE_ICON } from "./icons";

type Props = {
  center: { lat: number; lon: number };
  boundary?: { type: "Polygon"; coordinates: [number, number][][] } | null;
  bbox?: [number, number, number, number];
  showCoverage?: boolean;
  showDataCoverage?: boolean;
  layerState?: LayerState;
  path?: LatLon[] | null;
  start?: LatLon | null;
  end?: LatLon | null;
  me?: LatLon | null;
  from?: Place | null;
  places?: PlaceOnWay[];
  fitKey?: string;
  bottomPad: number;
  offline: boolean;
  layerVersion?: number;
  routes?: import("../types").RouteItem[];
  selectedRouteId?: string;
  onSelectRoute?: (id: string) => void;
  showDominated?: boolean;
  onPick?: ((lat: number, lon: number) => void) | null;
  onTakeMeThere?: ((p: { lat: number; lon: number; name: string }) => void) | null;
  onFacilityCounts?: ((counts: { medicine: number; food: number; hospital: number; police: number }) => void) | null;
};

const ACCENT = "#8b7cff";

function pinIcon(): L.DivIcon {
  return L.divIcon({
    className: "",
    iconSize: [30, 38],
    iconAnchor: [15, 36],
    html: `<svg width="30" height="38" viewBox="0 0 30 38" aria-hidden="true"><path d="M15 37s13-12.6 13-22A13 13 0 0 0 2 15c0 9.4 13 22 13 22z" fill="${ACCENT}" stroke="#fff" stroke-width="2.5"/><circle cx="15" cy="15" r="5" fill="#fff"/></svg>`,
  });
}

function placeIcon(p: PlaceOnWay): L.DivIcon {
  const ring = p.state === "open" ? "#34d399" : p.state === "maybe_open" ? "#fbbf24" : "#c3cae6";
  return L.divIcon({
    className: "",
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    html: `<div style="width:34px;height:34px;border-radius:50%;background:#131b31;border:3px solid ${ring};display:flex;align-items:center;justify-content:center;font-size:17px">${PLACE_ICON[p.type] || "📍"}</div>`,
  });
}

// Facility icons by category group
const FACILITY_ICONS: Record<FacilityCategory, string> = {
  medicine: "💊",
  food: "🍲",
  hospital: "🏥",
  police: "👮",
};

// Ring colors by hours tier
function tierColor(tier: HoursTier): { color: string; borderStyle: string } {
  switch (tier) {
    case "open":
      return { color: "#34d399", borderStyle: "solid" };
    case "maybe_open":
      return { color: "#fbbf24", borderStyle: "solid" };
    case "unknown":
      return { color: "#94a3b8", borderStyle: "dashed" };
    case "closed":
      return { color: "#f87171", borderStyle: "solid" };
    default:
      return { color: "#94a3b8", borderStyle: "dashed" };
  }
}

function facilityMarkerIcon(group: FacilityCategory, tier: HoursTier): L.DivIcon {
  const { color, borderStyle } = tierColor(tier);
  const icon = FACILITY_ICONS[group] || "📍";
  return L.divIcon({
    className: "",
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    html: `<div style="width:36px;height:36px;border-radius:50%;background:#131b31;border:3px ${borderStyle} ${color};display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 3px 10px rgba(0,0,0,0.5)">${icon}</div>`,
  });
}

// Distance calculation
function haversineDistM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Color scale interpolations for raster layers
function viirsColor(radiance: number | null): string {
  if (radiance === null || isNaN(radiance)) return "#475569";
  // Clamp radiance between 100 and 110
  const ratio = Math.max(0, Math.min(1, (radiance - 104) / 6.0));
  if (ratio < 0.25) return "#1e1b4b";
  if (ratio < 0.5) return "#2563eb";
  if (ratio < 0.75) return "#38bdf8";
  if (ratio < 0.9) return "#facc15";
  return "#ffffff";
}

function thermalColor(tempC: number | null): string {
  if (tempC === null || isNaN(tempC)) return "#475569";
  // Clamp between 18C and 30C
  const ratio = Math.max(0, Math.min(1, (tempC - 18) / 12.0));
  if (ratio < 0.2) return "#313695";
  if (ratio < 0.4) return "#4575b4";
  if (ratio < 0.6) return "#74add1";
  if (ratio < 0.75) return "#fee090";
  if (ratio < 0.9) return "#fdae61";
  return "#d73027";
}

function hexToRgb(hex: string): [number, number, number] {
  let c = hex.replace("#", "");
  if (c.length === 3) c = c.split("").map((x) => x + x).join("");
  const num = parseInt(c, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

// 1. Bilinear Smooth Surface: masks any quad having an UNKNOWN corner cell
function renderSmoothLayer(
  fc: any,
  colorFn: (val: number | null) => string,
  rg: L.LayerGroup,
  opacity: number,
  map: L.Map | null
) {
  const feats = (fc.features || []).filter(
    (f: any) => f.properties && f.properties.lat != null && f.properties.lon != null
  );
  if (feats.length === 0) return;

  const latsSet = new Set<number>();
  const lonsSet = new Set<number>();
  feats.forEach((f: any) => {
    latsSet.add(Math.round(f.properties.lat * 10000) / 10000);
    lonsSet.add(Math.round(f.properties.lon * 10000) / 10000);
  });

  const lats = Array.from(latsSet).sort((a, b) => a - b);
  const lons = Array.from(lonsSet).sort((a, b) => a - b);
  if (lats.length < 2 || lons.length < 2) return;

  const minLat = lats[0];
  const maxLat = lats[lats.length - 1];
  const minLon = lons[0];
  const maxLon = lons[lons.length - 1];

  const cellMap = new Map<string, { val: number | null; isUnknown: boolean; prop: any }>();
  feats.forEach((f: any) => {
    const p = f.properties;
    const rLat = Math.round(p.lat * 10000) / 10000;
    const rLon = Math.round(p.lon * 10000) / 10000;
    const row = lats.indexOf(rLat);
    const col = lons.indexOf(rLon);
    if (row !== -1 && col !== -1) {
      const isUnknown = p.status === "UNKNOWN" || p.value === null || p.value === undefined;
      cellMap.set(`${row}_${col}`, {
        val: isUnknown ? null : Number(p.value),
        isUnknown,
        prop: p,
      });
    }
  });

  const canvas = document.createElement("canvas");
  const W = 220;
  const H = 220;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const imgData = ctx.createImageData(W, H);
  const data = imgData.data;

  for (let py = 0; py < H; py++) {
    const lat = maxLat - (py / (H - 1)) * (maxLat - minLat);
    let r0 = 0;
    while (r0 < lats.length - 2 && lats[r0 + 1] < lat) r0++;
    const r1 = Math.min(lats.length - 1, r0 + 1);

    for (let px = 0; px < W; px++) {
      const lon = minLon + (px / (W - 1)) * (maxLon - minLon);
      let c0 = 0;
      while (c0 < lons.length - 2 && lons[c0 + 1] < lon) c0++;
      const c1 = Math.min(lons.length - 1, c0 + 1);

      const p00 = cellMap.get(`${r0}_${c0}`);
      const p10 = cellMap.get(`${r0}_${c1}`);
      const p01 = cellMap.get(`${r1}_${c0}`);
      const p11 = cellMap.get(`${r1}_${c1}`);

      const pIdx = (py * W + px) * 4;

      // HONESTY RULE: If ANY contributing cell is UNKNOWN, mask it out (transparent)
      if (!p00 || !p10 || !p01 || !p11 || p00.isUnknown || p10.isUnknown || p01.isUnknown || p11.isUnknown) {
        data[pIdx + 3] = 0;
        continue;
      }

      const u = (lon - lons[c0]) / Math.max(1e-6, lons[c1] - lons[c0]);
      const v = (lat - lats[r0]) / Math.max(1e-6, lats[r1] - lats[r0]);
      const uClamped = Math.max(0, Math.min(1, u));
      const vClamped = Math.max(0, Math.min(1, v));

      const v00 = p00.val!;
      const v10 = p10.val!;
      const v01 = p01.val!;
      const v11 = p11.val!;

      const interpolated =
        (1 - uClamped) * (1 - vClamped) * v00 +
        uClamped * (1 - vClamped) * v10 +
        (1 - uClamped) * vClamped * v01 +
        uClamped * vClamped * v11;

      const hex = colorFn(interpolated);
      const [r, g, b] = hexToRgb(hex);
      data[pIdx] = r;
      data[pIdx + 1] = g;
      data[pIdx + 2] = b;
      data[pIdx + 3] = Math.round(opacity * 230);
    }
  }

  ctx.putImageData(imgData, 0, 0);

  const overlay = L.imageOverlay(canvas.toDataURL(), [[minLat, minLon], [maxLat, maxLon]], {
    pane: "rasterPane",
    opacity: 1,
    interactive: true,
  });

  overlay.on("click", (e: L.LeafletMouseEvent) => {
    let bestCell: any = null;
    let minDist = Infinity;
    feats.forEach((f: any) => {
      const d = (f.properties.lat - e.latlng.lat) ** 2 + (f.properties.lon - e.latlng.lng) ** 2;
      if (d < minDist) {
        minDist = d;
        bestCell = f.properties;
      }
    });
    if (bestCell && map) {
      const isUnknown = bestCell.status === "UNKNOWN" || bestCell.value === null;
      const content = isUnknown
        ? `<div style="font-family:sans-serif;padding:2px"><div style="font-weight:bold;color:#f87171">No data (cloud-masked or not observed)</div><div style="font-size:11px;color:#94a3b8;margin-top:2px">Status: UNKNOWN</div></div>`
        : `<div style="font-family:sans-serif;padding:2px"><div style="font-weight:bold;font-size:14px;color:#f4f6ff">${bestCell.value} ${bestCell.unit || ""}</div><div style="font-size:11px;color:#34d399">Status: ${bestCell.status || "Known"}</div><div style="font-size:10px;color:#94a3b8;margin-top:2px">Smoothed for display. True resolution native cell.</div></div>`;
      L.popup({ className: "nw-popup" })
        .setLatLng(e.latlng)
        .setContent(content)
        .openOn(map);
    }
  });

  overlay.addTo(rg);
}

// 2. Streets Mode: color and glow street segments by lighting or observation
function renderStreetsLayer(
  layerType: "viirs" | "thermal" | "weather",
  fc: any,
  streetsFc: any,
  colorFn: (val: number | null) => string,
  rg: L.LayerGroup,
  opacity: number
) {
  const cells = (fc.features || []).filter(
    (f: any) => f.properties && f.properties.lat != null && f.properties.lon != null
  );

  L.geoJSON(streetsFc, {
    pane: "rasterPane",
    style: (feature) => {
      const geom = feature?.geometry as any;
      const coords = geom?.coordinates || [];
      const light = feature?.properties?.light ?? 0;
      let midLat = 0;
      let midLon = 0;
      if (coords.length > 0) {
        const midIdx = Math.floor(coords.length / 2);
        midLon = coords[midIdx][0];
        midLat = coords[midIdx][1];
      }

      let nearestVal: number | null = null;
      let minDist = Infinity;
      for (const c of cells) {
        const d = (c.properties.lat - midLat) ** 2 + (c.properties.lon - midLon) ** 2;
        if (d < minDist) {
          minDist = d;
          nearestVal = c.properties.value ?? c.properties.radiance ?? null;
        }
      }

      if (layerType === "viirs") {
        // Real OSM lit tags or mapped street lamps = solid, KNOWN
        if (light === 3) {
          return { color: "#ffffff", weight: 3.5, opacity: 0.95 * opacity };
        }
        // Main-road prior = solid
        if (light === 2) {
          return { color: "#f59e0b", weight: 2.5, opacity: 0.85 * opacity };
        }
        // Lighting is UNKNOWN: use VIIRS value as PROBABLE prior drawn dashed & lower opacity
        if (nearestVal !== null && nearestVal > 0) {
          return {
            color: viirsColor(nearestVal),
            weight: 2.2,
            opacity: 0.65 * opacity,
            dashArray: "4, 4",
          };
        }
        // No data draw hatched grey
        return {
          color: "#64748b",
          weight: 1.5,
          opacity: 0.45 * opacity,
          dashArray: "2, 4",
        };
      } else {
        if (nearestVal !== null) {
          return { color: colorFn(nearestVal), weight: 2.5, opacity: 0.85 * opacity };
        }
        return { color: "#475569", weight: 1.5, opacity: 0.4 * opacity, dashArray: "2, 4" };
      }
    },
    onEachFeature: (feature, l) => {
      const p = feature.properties || {};
      const light = p.light ?? 0;
      let note = "";
      if (layerType === "viirs") {
        if (light === 3) note = "OSM lit tag / mapped street lamps (solid, KNOWN)";
        else if (light === 2) note = "Main-road prior (solid, PROBABLE)";
        else note = "OSM lighting UNKNOWN. VIIRS estimate drawn dashed (PROBABLE prior)";
      } else {
        note = `Street segment colored by nearest ${layerType} observation.`;
      }
      const content = `<div style="font-family:sans-serif;padding:2px"><div style="font-weight:bold;color:#f4f6ff">${p.name || "Street"}</div><div style="font-size:11px;color:#38bdf8;margin-top:2px">${note}</div></div>`;
      l.bindPopup(content, { className: "nw-popup" });
    },
  }).addTo(rg);
}

// 3. Cells Mode: Native-resolution blocks
function renderCellsLayer(
  fc: any,
  colorFn: (val: number | null) => string,
  rg: L.LayerGroup,
  opacity: number
) {
  L.geoJSON(fc, {
    pane: "rasterPane",
    style: (feature) => {
      const props = feature?.properties || {};
      const isUnknown = props.status === "UNKNOWN" || props.value === null || props.value === undefined;
      if (isUnknown) {
        return {
          fillColor: "#475569",
          fillOpacity: 0.85 * opacity,
          color: "#64748b",
          weight: 1,
          dashArray: "3, 3",
        };
      }
      return {
        fillColor: colorFn(props.value),
        fillOpacity: opacity,
        stroke: false,
      };
    },
    onEachFeature: (feature, l) => {
      const p = feature.properties || {};
      const isUnknown = p.status === "UNKNOWN" || p.value === null || p.value === undefined;
      const content = isUnknown
        ? `<div style="font-family:sans-serif;padding:2px"><div style="font-weight:bold;color:#f87171">No data (cloud-masked or not observed)</div><div style="font-size:11px;color:#94a3b8;margin-top:2px">Status: UNKNOWN</div></div>`
        : `<div style="font-family:sans-serif;padding:2px"><div style="font-weight:bold;font-size:14px;color:#f4f6ff">${p.value} ${p.unit || ""}</div><div style="font-size:11px;color:#34d399">Status: ${p.status || "Known"}</div><div style="font-size:10px;color:#94a3b8;margin-top:2px">Native cell resolution.</div></div>`;
      l.bindPopup(content, { closeButton: false, className: "nw-popup" });
    },
  }).addTo(rg);
}

export function MapCanvas({
  center,
  boundary,
  bbox,
  showCoverage = true,
  showDataCoverage = false,
  layerState,
  path,
  start,
  end,
  me,
  from,
  places,
  fitKey,
  bottomPad,
  offline,
  layerVersion = 0,
  routes,
  selectedRouteId,
  onSelectRoute,
  showDominated = false,
  onPick,
  onTakeMeThere,
  onFacilityCounts,
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const coverageGroup = useRef<L.LayerGroup | null>(null);
  const dataCoverageGroup = useRef<L.LayerGroup | null>(null);
  const rasterGroup = useRef<L.LayerGroup | null>(null);
  const clusterGroup = useRef<any>(null);
  const streets = useRef<L.GeoJSON | null>(null);
  const streetsCache = useRef<GeoJSON.FeatureCollection | null>(null);
  const tileErrors = useRef(0);
  const initialFitDone = useRef(false);
  const allPoisRef = useRef<FacilityPOI[]>([]);
  const [poisLoaded, setPoisLoaded] = useState(false);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  // Load facilities from /api/map/pois
  useEffect(() => {
    api
      .mapPois()
      .then((fc: any) => {
        const features = fc.features || [];
        const pois: FacilityPOI[] = [];
        const counts = { medicine: 0, food: 0, hospital: 0, police: 0 };
        for (const f of features) {
          const props = f.properties || {};
          const cat = props.category_group as FacilityCategory | undefined;
          if (cat && cat in counts) {
            counts[cat] += 1;
          }
          const geom = f.geometry || {};
          const coords = geom.coordinates || [0, 0];
          pois.push({
            id: props.id || String(Math.random()),
            name: props.name || "Facility",
            cat: props.cat || "",
            category_group: cat || null,
            lat: coords[1],
            lon: coords[0],
            tier: (props.hours_state?.tier as HoursTier) || "unknown",
            hours_state: props.hours_state || {
              tier: "unknown",
              open: null,
              status: "unknown",
              text: props.hours_text || (props.is_24h ? "Open 24/7" : "Hours unlisted"),
            },
            last_osm_edit: props.last_osm_edit || null,
            is_24h: Boolean(props.is_24h),
          });
        }
        allPoisRef.current = pois;
        setPoisLoaded(true);
        if (onFacilityCounts) {
          onFacilityCounts(counts);
        }
      })
      .catch(() => {});
  }, [onFacilityCounts]);

  useEffect(() => {
    if (!box.current) return;
    const m = L.map(box.current, { zoomControl: false, attributionControl: true, preferCanvas: true })
      .setView([center.lat, center.lon], 14);
    m.attributionControl.setPrefix(false);

    // Pane layering:
    // Base tiles: 200
    // Raster layers (native blocky cells): 250
    // Coverage outline and mask: 350
    // Routes and lines: 400
    // Markers and clusters: 600
    m.createPane("rasterPane");
    const rp = m.getPane("rasterPane");
    if (rp) rp.style.zIndex = "250";

    m.createPane("coveragePane");
    const cp = m.getPane("coveragePane");
    if (cp) cp.style.zIndex = "350";

    const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      className: "nw-tiles",
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m);
    tiles.on("tileerror", () => {
      tileErrors.current += 1;
      if (tileErrors.current === 4) showStreets();
    });

    rasterGroup.current = L.layerGroup().addTo(m);
    coverageGroup.current = L.layerGroup().addTo(m);
    dataCoverageGroup.current = L.layerGroup().addTo(m);

    // Marker cluster group
    const cg = (L as any).markerClusterGroup({
      maxClusterRadius: 36,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      zoomToBoundsOnClick: true,
    });
    clusterGroup.current = cg;
    m.addLayer(cg);

    layer.current = L.layerGroup().addTo(m);

    m.on("click", (e: L.LeafletMouseEvent) => pickRef.current?.(e.latlng.lat, e.latlng.lng));
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(box.current);

    // Fetch initial POIs for facilities
    api.mapPois().then((fc) => {
      const parsed: FacilityPOI[] = (fc.features || [])
        .filter((f: any) => f.properties?.category_group)
        .map((f: any) => {
          const coords = f.geometry.coordinates;
          const p = f.properties;
          return {
            id: p.id,
            name: p.name || "Facility",
            cat: p.cat,
            category_group: p.category_group,
            lat: coords[1],
            lon: coords[0],
            tier: p.tier || "unknown",
            hours_state: p.hours_state || { tier: "unknown", open: null, status: "UNKNOWN", text: "" },
            last_osm_edit: p.last_osm_edit || p.edited_at || null,
            is_24h: !!p.is_24h,
          };
        });
      allPoisRef.current = parsed;

      // Report counts
      const counts = { medicine: 0, food: 0, hospital: 0, police: 0 };
      for (const poi of parsed) {
        if (poi.category_group && poi.category_group in counts) {
          counts[poi.category_group]++;
        }
      }
      onFacilityCounts?.(counts);
    }).catch(() => {});

    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
    };
  }, [center.lat, center.lon]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initial fit & limit to polygon bounding box on load
  useEffect(() => {
    const m = map.current;
    if (!m || initialFitDone.current) return;
    if (bbox && bbox.length === 4) {
      const [minLon, minLat, maxLon, maxLat] = bbox;
      const bounds = L.latLngBounds([
        [minLat, minLon],
        [maxLat, maxLon],
      ]);
      m.fitBounds(bounds, { padding: [28, 28] });

      const dLat = (maxLat - minLat) * 0.2;
      const dLon = (maxLon - minLon) * 0.2;
      const maxBounds = L.latLngBounds([
        [minLat - dLat, minLon - dLon],
        [maxLat + dLat, maxLon + dLon],
      ]);
      m.setMaxBounds(maxBounds);
      m.setMinZoom(12);
      initialFitDone.current = true;
    }
  }, [bbox]);

  // Offline base map
  function showStreets() {
    if (streets.current || !map.current) return;
    api
      .streetsMain()
      .then((fc) => {
        if (!map.current || streets.current) return;
        streets.current = L.geoJSON(fc, {
          style: { color: "#3a4874", weight: 2, opacity: 0.9 },
          interactive: false,
        }).addTo(map.current);
        streets.current.bringToBack();
      })
      .catch(() => {});
  }
  useEffect(() => {
    if (offline) showStreets();
  }, [offline]);

  // Boundary outline + mask
  useEffect(() => {
    const cg = coverageGroup.current;
    if (!cg) return;
    cg.clearLayers();

    const isCoverageOn = layerState?.showCoverage ?? showCoverage;
    if (isCoverageOn && boundary && boundary.coordinates?.length) {
      const ring = boundary.coordinates[0];
      const ringLatLngs: [number, number][] = ring.map(([lon, lat]) => [lat, lon]);

      const outerBox: [number, number][] = [
        [-85, -180],
        [85, -180],
        [85, 180],
        [-85, 180],
        [-85, -180],
      ];
      L.polygon([outerBox, ringLatLngs], {
        pane: "coveragePane",
        fillColor: "#060913",
        fillOpacity: 0.45,
        stroke: false,
        interactive: false,
      }).addTo(cg);

      L.polyline(ringLatLngs, {
        pane: "coveragePane",
        color: ACCENT,
        weight: 8,
        opacity: 0.25,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      }).addTo(cg);

      L.polyline(ringLatLngs, {
        pane: "coveragePane",
        color: ACCENT,
        weight: 3,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      }).addTo(cg);
    }
  }, [boundary, showCoverage, layerState?.showCoverage]);

  // Data coverage layer
  useEffect(() => {
    const dg = dataCoverageGroup.current;
    if (!dg) return;
    dg.clearLayers();

    if (showDataCoverage) {
      api
        .streetsAll()
        .then((fc) => {
          if (!dataCoverageGroup.current) return;
          L.geoJSON(fc, {
            style: (feature) => {
              const light = feature?.properties?.light ?? 0;
              if (light === 3) return { color: "#34d399", weight: 3, opacity: 0.85 };
              if (light === 2) return { color: "#60a5fa", weight: 2.5, opacity: 0.8 };
              return { color: "#94a3b8", weight: 2, opacity: 0.5 };
            },
            interactive: false,
          }).addTo(dg);
        })
        .catch(() => {});
    }
  }, [showDataCoverage]);

  // Raster Layer Renderer (Multi-mode: Streets, Smooth bilinear surface, or Native Cells)
  useEffect(() => {
    const rg = rasterGroup.current;
    if (!rg) return;
    rg.clearLayers();

    if (!layerState) return;

    // 1. VIIRS Night Lights
    if (layerState.viirs.enabled) {
      const opacity = layerState.viirs.opacity;
      const mode = layerState.viirs.mode || "streets";
      api
        .layerData("viirs_ntl")
        .then((fc) => {
          if (!rasterGroup.current) return;
          if (mode === "smooth") {
            renderSmoothLayer(fc, viirsColor, rasterGroup.current, opacity, map.current);
          } else if (mode === "streets") {
            const doRenderStreets = (stFc: any) => {
              if (rasterGroup.current) {
                renderStreetsLayer("viirs", fc, stFc, viirsColor, rasterGroup.current, opacity);
              }
            };
            if (streetsCache.current) {
              doRenderStreets(streetsCache.current);
            } else {
              api
                .streetsAll()
                .then((stFc) => {
                  streetsCache.current = stFc;
                  doRenderStreets(stFc);
                })
                .catch(() => renderCellsLayer(fc, viirsColor, rasterGroup.current!, opacity));
            }
          } else {
            renderCellsLayer(fc, viirsColor, rasterGroup.current, opacity);
          }
        })
        .catch(() => {});
    }

    // 2. Thermal Layer (Night surface LST or Air Temp)
    else if (layerState.thermal.enabled) {
      const opacity = layerState.thermal.opacity;
      const mode = layerState.thermal.mode || "cells";
      const isAir = layerState.thermal.source === "air_temp";
      const layerId = isAir ? "weather_grid" : "thermal_lst";
      const hour = isAir ? layerState.thermal.hour : undefined;
      api
        .layerData(layerId, hour)
        .then((fc) => {
          if (!rasterGroup.current) return;
          if (mode === "smooth") {
            renderSmoothLayer(fc, thermalColor, rasterGroup.current, opacity, map.current);
          } else if (mode === "streets") {
            const doRenderStreets = (stFc: any) => {
              if (rasterGroup.current) {
                renderStreetsLayer("thermal", fc, stFc, thermalColor, rasterGroup.current, opacity);
              }
            };
            if (streetsCache.current) {
              doRenderStreets(streetsCache.current);
            } else {
              api
                .streetsAll()
                .then((stFc) => {
                  streetsCache.current = stFc;
                  doRenderStreets(stFc);
                })
                .catch(() => renderCellsLayer(fc, thermalColor, rasterGroup.current!, opacity));
            }
          } else {
            renderCellsLayer(fc, thermalColor, rasterGroup.current, opacity);
          }
        })
        .catch(() => {});
    }

    // 3. Weather Forecast Grid
    else if (layerState.weather.enabled) {
      const opacity = layerState.weather.opacity;
      const mode = layerState.weather.mode || "cells";
      api
        .layerData("weather_grid", layerState.weather.hour)
        .then((fc) => {
          if (!rasterGroup.current) return;
          if (mode === "smooth") {
            renderSmoothLayer(fc, thermalColor, rasterGroup.current, opacity, map.current);
          } else if (mode === "streets") {
            const doRenderStreets = (stFc: any) => {
              if (rasterGroup.current) {
                renderStreetsLayer("weather", fc, stFc, thermalColor, rasterGroup.current, opacity);
              }
            };
            if (streetsCache.current) {
              doRenderStreets(streetsCache.current);
            } else {
              api
                .streetsAll()
                .then((stFc) => {
                  streetsCache.current = stFc;
                  doRenderStreets(stFc);
                })
                .catch(() => renderCellsLayer(fc, thermalColor, rasterGroup.current!, opacity));
            }
          } else {
            renderCellsLayer(fc, thermalColor, rasterGroup.current, opacity);
          }
        })
        .catch(() => {});
    }
  }, [
    layerState?.viirs.enabled,
    layerState?.viirs.opacity,
    layerState?.viirs.mode,
    layerState?.thermal.enabled,
    layerState?.thermal.opacity,
    layerState?.thermal.source,
    layerState?.thermal.mode,
    layerState?.thermal.hour,
    layerState?.weather.enabled,
    layerState?.weather.opacity,
    layerState?.weather.mode,
    layerState?.weather.hour,
    layerVersion,
  ]);

  // Facility Markers with Cluster Group
  useEffect(() => {
    const cg = clusterGroup.current;
    if (!cg) return;
    cg.clearLayers();

    if (!layerState) return;

    const { medicine, food, hospital, police, openOnly, includeUnknown } = layerState.facilities;
    const anyFacilityActive = medicine || food || hospital || police;
    if (!anyFacilityActive) return;

    const filtered = allPoisRef.current.filter((poi) => {
      if (!poi.category_group) return false;
      if (!layerState.facilities[poi.category_group]) return false;
      if (openOnly && poi.tier !== "open" && poi.tier !== "maybe_open") return false;
      if (!includeUnknown && poi.tier === "unknown") return false;
      return true;
    });

    const originLat = from?.lat ?? center.lat;
    const originLon = from?.lon ?? center.lon;

    for (const poi of filtered) {
      const distM = haversineDistM(originLat, originLon, poi.lat, poi.lon);
      const walkMin = Math.round(distM / 80); // ~4.8 km/h walking speed
      const distKm = (distM / 1000).toFixed(1);

      const m = L.marker([poi.lat, poi.lon], {
        icon: facilityMarkerIcon(poi.category_group!, poi.tier),
        title: poi.name,
      });

      const tierBadge =
        poi.tier === "open"
          ? `<span style="background:rgba(52,211,153,0.2);color:#34d399;font-weight:bold;padding:1px 6px;border-radius:4px;font-size:11px">Open</span>`
          : poi.tier === "maybe_open"
          ? `<span style="background:rgba(251,191,36,0.2);color:#fbbf24;font-weight:bold;padding:1px 6px;border-radius:4px;font-size:11px">Likely open</span>`
          : `<span style="background:rgba(148,163,184,0.2);color:#94a3b8;font-weight:bold;padding:1px 6px;border-radius:4px;font-size:11px;border:1px dashed #64748b">Unlisted hours</span>`;

      const editedText = poi.last_osm_edit ? poi.last_osm_edit.slice(0, 10) : "OSM";
      const hoursText = poi.hours_state.text ? `"${poi.hours_state.text}"` : "No hours in OSM";

      const popupHtml = `
        <div style="font-family:sans-serif;min-width:200px;color:#f4f6ff;padding:4px">
          <div style="font-size:15px;font-weight:bold;margin-bottom:4px">${poi.name}</div>
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
            <span style="font-size:12px;color:#c3cae6">${poi.cat.replace("_", " ")}</span>
            ${tierBadge}
          </div>
          <div style="font-size:12px;color:#94a3b8;margin-bottom:2px">Hours: ${hoursText}</div>
          <div style="font-size:11px;color:#64748b;margin-bottom:8px">Last edit: ${editedText} · ${distKm} km (${walkMin} min walk)</div>
          <div style="display:flex;gap:6px;margin-top:6px">
            <button id="btn-take-${poi.id}" style="background:#8b7cff;color:#0a0f1e;font-weight:bold;border:none;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px;flex:1">Take me there</button>
          </div>
        </div>
      `;

      m.bindPopup(popupHtml, { className: "nw-facility-popup" });
      m.on("popupopen", () => {
        const btn = document.getElementById(`btn-take-${poi.id}`);
        if (btn) {
          btn.onclick = () => {
            onTakeMeThere?.({ lat: poi.lat, lon: poi.lon, name: poi.name });
            m.closePopup();
          };
        }
      });

      cg.addLayer(m);
    }
  }, [
    layerState?.facilities.medicine,
    layerState?.facilities.food,
    layerState?.facilities.hospital,
    layerState?.facilities.police,
    layerState?.facilities.openOnly,
    layerState?.facilities.includeUnknown,
    from,
    center,
    onTakeMeThere,
    poisLoaded,
  ]);

  // Plan routes & markers (Multi-route engine support)
  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();

    if (routes && routes.length > 0) {
      const visibleRoutes = routes.filter((r) => !r.dominated || showDominated);
      // Sort so recommended / selected route is drawn on top
      const sortedRoutes = [...visibleRoutes].sort((a, b) => {
        const aSel = selectedRouteId ? a.id === selectedRouteId : a.recommended;
        const bSel = selectedRouteId ? b.id === selectedRouteId : b.recommended;
        if (aSel && !bSel) return 1;
        if (!aSel && bSel) return -1;
        if (a.dominated && !b.dominated) return -1;
        if (!a.dominated && b.dominated) return 1;
        return 0;
      });

      for (const r of sortedRoutes) {
        if (!r.polyline || r.polyline.length < 2) continue;
        const isSelected = selectedRouteId ? r.id === selectedRouteId : r.recommended;

        if (r.dominated) {
          // Dominated: faint dashed
          const poly = L.polyline(r.polyline, {
            color: "#94a3b8",
            weight: 3,
            dashArray: "6, 6",
            opacity: 0.5,
            interactive: true,
          }).addTo(g);
          poly.on("click", () => onSelectRoute?.(r.id));
        } else if (isSelected) {
          // Recommended / Selected: thick solid
          L.polyline(r.polyline, {
            color: "#0a0f1e",
            weight: 12,
            opacity: 0.9,
            interactive: false,
          }).addTo(g);
          const poly = L.polyline(r.polyline, {
            color: ACCENT,
            weight: 7,
            opacity: 1.0,
            interactive: true,
          }).addTo(g);
          poly.on("click", () => onSelectRoute?.(r.id));
        } else {
          // Others: thinner solid (labelled A, B, C...)
          const poly = L.polyline(r.polyline, {
            color: "#60a5fa",
            weight: 4.5,
            opacity: 0.85,
            interactive: true,
          }).addTo(g);
          poly.on("click", () => onSelectRoute?.(r.id));

          // Letter label badge marker at midpoint
          const midIdx = Math.floor(r.polyline.length / 2);
          const midPt = r.polyline[midIdx];
          const badgeIcon = L.divIcon({
            className: "",
            iconSize: [22, 22],
            iconAnchor: [11, 11],
            html: `<div style="width:22px;height:22px;border-radius:50%;background:#2563eb;color:#ffffff;border:2px solid #ffffff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:bold;box-shadow:0 2px 6px rgba(0,0,0,0.6);cursor:pointer">${r.label.replace("Way ", "")}</div>`,
          });
          const badgeMarker = L.marker(midPt, { icon: badgeIcon, interactive: true }).addTo(g);
          badgeMarker.on("click", () => onSelectRoute?.(r.id));
        }
      }
    } else if (path && path.length > 1) {
      L.polyline(path, { color: "#0a0f1e", weight: 11, opacity: 0.85, interactive: false }).addTo(g);
      L.polyline(path, { color: ACCENT, weight: 6, opacity: 1, interactive: false }).addTo(g);
    }

    if (start) L.circleMarker(start, { radius: 8, color: ACCENT, weight: 4, fillColor: "#fff", fillOpacity: 1 }).addTo(g);
    if (end) L.marker(end, { icon: pinIcon(), keyboard: false }).addTo(g);
    (places || []).forEach((p) => L.marker([p.lat, p.lon], { icon: placeIcon(p), title: p.name, alt: p.name }).addTo(g));
    if (me)
      L.marker(me, {
        icon: L.divIcon({ className: "", html: '<div class="nw-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      }).addTo(g);
  }, [routes, selectedRouteId, showDominated, onSelectRoute, path, start, end, me, places]);

  // Fit bounds when route or points change
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const pts: LatLon[] = [...(path || []), ...(places || []).map((p) => [p.lat, p.lon] as LatLon)];
    if (routes && routes.length > 0) {
      for (const r of routes) {
        if (!r.dominated || showDominated) {
          for (const c of r.polyline) {
            pts.push(c);
          }
        }
      }
    }
    if (start) pts.push(start);
    if (end) pts.push(end);
    if (pts.length === 0) return;
    if (pts.length === 1) {
      m.setView(pts[0], 15);
      return;
    }
    m.fitBounds(L.latLngBounds(pts), {
      paddingTopLeft: [28, 80],
      paddingBottomRight: [28, bottomPad + 24],
      maxZoom: 16,
    });
  }, [fitKey, routes, showDominated]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeSmoothBadge =
    layerState?.viirs.enabled && layerState?.viirs.mode === "smooth"
      ? "Smoothed for display. True resolution about 500 m."
      : layerState?.thermal.enabled && layerState?.thermal.mode === "smooth"
      ? "Smoothed for display. True resolution about 1 km."
      : layerState?.weather.enabled && layerState?.weather.mode === "smooth"
      ? "Smoothed for display. True resolution about 2 km."
      : null;

  return (
    <>
      <div
        ref={box}
        className="absolute inset-0 isolate z-0"
        style={{ cursor: onPick ? "crosshair" : undefined }}
        role="img"
        aria-label="map"
      />
      {activeSmoothBadge && (
        <div
          className="fixed bottom-24 left-4 z-20 flex items-center gap-2 rounded-xl border border-edge bg-surface/90 px-3 py-1.5 text-[0.76rem] font-semibold text-soft shadow-xl backdrop-blur-md"
          role="status"
          aria-live="polite"
        >
          <span className="text-[0.9rem]" aria-hidden="true">🔍</span>
          <span>{activeSmoothBadge}</span>
        </div>
      )}
    </>
  );
}

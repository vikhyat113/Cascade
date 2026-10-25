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

  // Raster Layer Renderer (Native Resolution blocky cells with Leaflet Canvas)
  useEffect(() => {
    const rg = rasterGroup.current;
    if (!rg) return;
    rg.clearLayers();

    if (!layerState) return;

    // 1. VIIRS Night Lights
    if (layerState.viirs.enabled) {
      const opacity = layerState.viirs.opacity;
      api
        .layerData("viirs_ntl")
        .then((fc) => {
          if (!rasterGroup.current) return;
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
                fillColor: viirsColor(props.value),
                fillOpacity: opacity,
                stroke: false,
              };
            },
            onEachFeature: (feature, l) => {
              const p = feature.properties || {};
              const isUnknown = p.status === "UNKNOWN" || p.value === null || p.value === undefined;
              const content = isUnknown
                ? `<div style="font-family:sans-serif;padding:2px"><div style="font-weight:bold;color:#f87171">No data (cloud-masked or not observed)</div><div style="font-size:11px;color:#94a3b8;margin-top:2px">Status: UNKNOWN</div></div>`
                : `<div style="font-family:sans-serif;padding:2px"><div style="font-weight:bold;font-size:14px;color:#f4f6ff">${p.value} ${p.unit}</div><div style="font-size:11px;color:#34d399">Percentile: ${p.percentile}% · Status: Known</div><div style="font-size:10px;color:#94a3b8;margin-top:2px">Acquisition: ${p.acquisition_time || "N/A"}</div></div>`;
              l.bindPopup(content, { closeButton: false, className: "nw-popup" });
            },
          }).addTo(rg);
        })
        .catch(() => {});
    }

    // 2. Thermal Layer (Night surface LST or Air Temp)
    else if (layerState.thermal.enabled) {
      const opacity = layerState.thermal.opacity;
      const layerId = layerState.thermal.source === "air_temp" ? "weather_grid" : "thermal_lst";
      api
        .layerData(layerId, layerState.weather.hour)
        .then((fc) => {
          if (!rasterGroup.current) return;
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
                fillColor: thermalColor(props.value),
                fillOpacity: opacity,
                stroke: false,
              };
            },
            onEachFeature: (feature, l) => {
              const p = feature.properties || {};
              const isUnknown = p.status === "UNKNOWN" || p.value === null || p.value === undefined;
              const content = isUnknown
                ? `<div style="font-family:sans-serif;padding:2px"><div style="font-weight:bold;color:#f87171">No data (cloud-masked or not observed)</div><div style="font-size:11px;color:#94a3b8;margin-top:2px">Status: UNKNOWN</div></div>`
                : `<div style="font-family:sans-serif;padding:2px"><div style="font-weight:bold;font-size:14px;color:#f4f6ff">${p.value} ${p.unit}</div><div style="font-size:11px;color:#34d399">Status: ${p.status || "Known"}</div><div style="font-size:10px;color:#94a3b8;margin-top:2px">Acquisition: ${p.acquisition_time || "N/A"}</div></div>`;
              l.bindPopup(content, { closeButton: false, className: "nw-popup" });
            },
          }).addTo(rg);
        })
        .catch(() => {});
    }

    // 3. Weather Forecast Grid
    else if (layerState.weather.enabled) {
      const opacity = layerState.weather.opacity;
      api
        .layerData("weather_grid", layerState.weather.hour)
        .then((fc) => {
          if (!rasterGroup.current) return;
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
                fillColor: thermalColor(props.value),
                fillOpacity: opacity,
                stroke: false,
              };
            },
            onEachFeature: (feature, l) => {
              const p = feature.properties || {};
              const isUnknown = p.status === "UNKNOWN" || p.value === null || p.value === undefined;
              const content = isUnknown
                ? `<div style="font-family:sans-serif;padding:2px"><div style="font-weight:bold;color:#f87171">No data</div></div>`
                : `<div style="font-family:sans-serif;padding:2px"><div style="font-weight:bold;font-size:14px;color:#f4f6ff">${p.value} ${p.unit}</div><div style="font-size:11px;color:#60a5fa">Rain: ${p.precipitation ?? 0} mm · Wind: ${p.wind_speed_10m ?? 0} km/h</div><div style="font-size:10px;color:#94a3b8;margin-top:2px">Hour: ${p.time || p.hour + ":00"}</div></div>`;
              l.bindPopup(content, { closeButton: false, className: "nw-popup" });
            },
          }).addTo(rg);
        })
        .catch(() => {});
    }
  }, [
    layerState?.viirs.enabled,
    layerState?.viirs.opacity,
    layerState?.thermal.enabled,
    layerState?.thermal.opacity,
    layerState?.thermal.source,
    layerState?.weather.enabled,
    layerState?.weather.opacity,
    layerState?.weather.hour,
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

  // Plan routes & markers
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
    if (me)
      L.marker(me, {
        icon: L.divIcon({ className: "", html: '<div class="nw-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      }).addTo(g);
  }, [path, start, end, me, places]);

  // Fit bounds when route or points change
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const pts: LatLon[] = [...(path || []), ...(places || []).map((p) => [p.lat, p.lon] as LatLon)];
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
  }, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={box}
      className="absolute inset-0 isolate z-0"
      style={{ cursor: onPick ? "crosshair" : undefined }}
      role="img"
      aria-label="map"
    />
  );
}

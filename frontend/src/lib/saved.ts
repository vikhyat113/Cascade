import type { Place, UiDefaults } from "../types";

// Home / Work are saved once on this phone (localStorage); defaults come from the demo config.
type Slot = "home" | "work";

export function loadPlace(slot: Slot, defaults: UiDefaults | null): Place | null {
  try {
    const raw = localStorage.getItem(`nw.${slot}`);
    if (raw) return { ...JSON.parse(raw), kind: slot };
  } catch { /* private mode */ }
  const d = defaults?.[slot];
  return d ? { lat: d.lat, lon: d.lon, name: d.name, kind: slot } : null;
}

export function savePlace(slot: Slot, p: Place): void {
  try { localStorage.setItem(`nw.${slot}`, JSON.stringify({ lat: p.lat, lon: p.lon, name: p.name })); } catch { /* ignore */ }
}

export function lastTrip(): string | null {
  try { return localStorage.getItem("nw.trip"); } catch { return null; }
}

export function rememberTrip(id: string | null): void {
  try { if (id) localStorage.setItem("nw.trip", id); else localStorage.removeItem("nw.trip"); } catch { /* ignore */ }
}

export function pointInPolygon(lon: number, lat: number, poly: { coordinates: [number, number][][] }): boolean {
  const ring = poly.coordinates[0];
  if (!ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function isInsideCoverage(
  lat: number,
  lon: number,
  cfg: { polygon?: { type: "Polygon"; coordinates: [number, number][][] } | null; center: { lat: number; lon: number }; radius_m: number }
): boolean {
  if (cfg.polygon && cfg.polygon.coordinates?.length) {
    return pointInPolygon(lon, lat, cfg.polygon);
  }
  const dLat = (lat - cfg.center.lat) * 110540;
  const dLon = (lon - cfg.center.lon) * 111320 * Math.cos((cfg.center.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon) <= cfg.radius_m;
}

/** "My location": the phone's position if it is inside the demo city, else the demo start point. */
export function myLocation(
  defaults: UiDefaults,
  center: { lat: number; lon: number },
  radius: number,
  polygon?: { type: "Polygon"; coordinates: [number, number][][] } | null
): Promise<Place> {
  const demo: Place = { ...defaults.start, kind: "here", demo: true };
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(demo);
    const timer = window.setTimeout(() => resolve(demo), 2500);
    navigator.geolocation.getCurrentPosition((pos) => {
      window.clearTimeout(timer);
      const { latitude: lat, longitude: lon } = pos.coords;
      const inside = polygon && polygon.coordinates?.length
        ? pointInPolygon(lon, lat, polygon)
        : Math.hypot((lat - center.lat) * 110540, (lon - center.lon) * 111320 * Math.cos((center.lat * Math.PI) / 180)) <= radius;
      resolve(inside ? { lat, lon, name: "", kind: "here" } : demo);
    }, () => { window.clearTimeout(timer); resolve(demo); }, { timeout: 2000, maximumAge: 60000 });
  });
}


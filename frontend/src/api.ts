import type { Lang } from "./copy";
import type { AppConfig, Place, PlaceOnWay, SimpleView } from "./types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  if (!r.ok) throw new Error(String(r.status));
  return r.json() as Promise<T>;
}
const post = <T>(path: string, body: unknown) => req<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  config: () => req<AppConfig>("/api/config"),
  status: () => req<{ connection: "live" | "offline"; now_text: string }>("/api/status"),
  plan: (from: Place, to: Place, when: string | null, by: string | null, lang: Lang) =>
    post<SimpleView>("/api/plan", {
      origin: { lat: from.lat, lon: from.lon, name: from.name },
      destination: { lat: to.lat, lon: to.lon, name: to.name, kind: to.kind ?? null },
      start_time: when, deadline: by, lang,
      // no risk slider in the simple UI: safest first, every mode allowed
      prefs: { risk_weight: 1.0, modes: ["walk", "bus", "cab"], max_walk_m: 2500 },
    }),
  getPlan: (id: string, lang: Lang) => req<SimpleView>(`/api/plan/${id}?lang=${lang}`),
  choose: (id: string, planId: string, lang: Lang) => post<SimpleView>(`/api/plan/${id}/choose`, { plan_id: planId, lang }),
  drop: (id: string) => req(`/api/plan/${id}`, { method: "DELETE" }).catch(() => {}),
  where: (lat: number, lon: number, lang: Lang) => req<{ name: string }>(`/api/where?lat=${lat}&lon=${lon}&lang=${lang}`),
  geocode: (q: string) => req<{ name: string; lat: number; lon: number; kind: string }[]>(`/api/geocode?q=${encodeURIComponent(q)}&limit=6`),
  needNow: (type: string, at: Place, lang: Lang) =>
    req<{ places: PlaceOnWay[]; empty_text: string | null }>(`/api/need-now?type=${type}&lat=${at.lat}&lon=${at.lon}&lang=${lang}`),
  sos: (at: Place, lang: Lang) => post<{ hospital: PlaceOnWay | null; police: PlaceOnWay | null }>("/api/sos", { lat: at.lat, lon: at.lon, lang }),
  share: (id: string) => post<{ url: string }>("/api/share", { plan_id: id }),
  streetsMain: () => req<GeoJSON.FeatureCollection>("/api/map/streets?main=1"),
  streetsAll: () => req<GeoJSON.FeatureCollection>("/api/map/streets"),
  areaDiagnostics: () => req<import("./types").AreaDiagnostics>("/api/area/diagnostics"),
  layers: () => req<import("./types").LayerMeta[]>("/api/layers"),
  layerData: (id: string, hour?: number) =>
    req<GeoJSON.FeatureCollection>(`/api/layers/${id}${hour !== undefined ? `?hour=${hour}` : ""}`),
  mapPois: (time?: string) =>
    req<GeoJSON.FeatureCollection>(`/api/map/pois${time ? `?time=${encodeURIComponent(time)}` : ""}`),
};

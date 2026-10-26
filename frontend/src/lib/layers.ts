// Map layers (UPGRADE §3): which are on, and the data that loads only when a layer is switched on.
// Night lights and the weather grid are bundled asset files fetched on first use; the rest comes from
// the engine worker. A missing file, or one that does not cover the area, means "Not available here".
import { Preferences } from "@capacitor/preferences";
import viirsUrl from "../data/layers/viirs.json?url";
import weatherUrl from "../data/layers/weather.json?url";

export type LayerId = "lit" | "heat" | "help" | "weather" | "night";
export interface LayerState {
  on: Record<LayerId, boolean>;
  strength: { heat: number; night: number };
  heatHour: number | null;            // null = follow the app clock
  helpNotSure: boolean; helpOpenOnly: boolean;
}
export const LAYER_DEFAULT: LayerState = {
  on: { lit: false, heat: false, help: false, weather: false, night: false },
  strength: { heat: 0.55, night: 0.35 }, heatHour: null, helpNotSure: false, helpOpenOnly: true,
};

export async function loadLayerState(): Promise<LayerState> {
  try {
    const { value } = await Preferences.get({ key: "nw.layers" });
    return value ? { ...LAYER_DEFAULT, ...(JSON.parse(value) as Partial<LayerState>) } : LAYER_DEFAULT;
  } catch { return LAYER_DEFAULT; }
}
export function saveLayerState(s: LayerState): void { Preferences.set({ key: "nw.layers", value: JSON.stringify(s) }).catch(() => {}); }

export interface Viirs { nights: string[]; bbox: { south: number; west: number; north: number; east: number }; cell_deg: number; nx: number; ny: number; values: number[] }
export interface WeatherGrid { fetched_at: string; time: string[]; points: { lat: number; lon: number; temp: (number | null)[]; rain_prob: (number | null)[]; rain_mm: (number | null)[] }[] }

const cache = new Map<string, Promise<unknown>>();
function lazy<T>(url: string): Promise<T | null> {
  if (!cache.has(url)) cache.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return cache.get(url) as Promise<T | null>;
}

/** Night lights, or null when the file is missing or does not cover the area. */
export async function loadViirs(area: [number, number, number, number]): Promise<Viirs | null> {
  const v = await lazy<Viirs>(viirsUrl);
  if (!v?.values?.length) return null;
  const [s, w, n, e] = area, b = v.bbox;
  return b.south <= s + 0.02 && b.west <= w + 0.02 && b.north >= n - 0.02 && b.east >= e - 0.02 ? v : null;
}
export async function loadWeatherGrid(): Promise<WeatherGrid | null> {
  const g = await lazy<WeatherGrid>(weatherUrl);
  return g?.points?.length ? g : null;
}

/** Night lights as a picture for an image overlay: warm light, transparent where dark. */
export function viirsImage(v: Viirs, rgb: [number, number, number]): string {
  const c = document.createElement("canvas");
  c.width = v.nx; c.height = v.ny;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(v.nx, v.ny);
  v.values.forEach((x, i) => {
    const a = x < 0 ? 0 : Math.max(0, (x - 90) / 165) ** 1.6;      // gentle: the city core saturates
    img.data.set([rgb[0], rgb[1], rgb[2], Math.round(255 * a)], i * 4);
  });
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

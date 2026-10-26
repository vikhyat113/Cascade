import { Geolocation } from "@capacitor/geolocation";
import { Preferences } from "@capacitor/preferences";
import type { Lang } from "../copy";
import { call } from "./engine";
import type { TripAsk } from "../engine/worker";
import type { Place, UiDefaults } from "../types";

// Saved on this phone with Capacitor Preferences: Home / Work, language and the last trip.
type Slot = "home" | "work";

async function read<T>(key: string): Promise<T | null> {
  try { const { value } = await Preferences.get({ key }); return value ? (JSON.parse(value) as T) : null; } catch { return null; }
}
function write(key: string, v: unknown): void {
  (v == null ? Preferences.remove({ key }) : Preferences.set({ key, value: JSON.stringify(v) })).catch(() => {});
}

export async function loadPlace(slot: Slot, defaults: UiDefaults | null): Promise<Place | null> {
  const p = await read<Place>(`nw.${slot}`);
  if (p) return { ...p, kind: slot };
  const d = defaults?.[slot];
  return d ? { lat: d.lat, lon: d.lon, name: d.name, kind: slot } : null;
}
export function savePlace(slot: Slot, p: Place): void { write(`nw.${slot}`, { lat: p.lat, lon: p.lon, name: p.name }); }

export async function loadFlag(key: string): Promise<boolean> { return (await read<boolean>(`nw.${key}`)) === true; }
export function saveFlag(key: string, on: boolean): void { write(`nw.${key}`, on); }

/** The last real GPS fix, for SOS while a new fix is slow ("Using last place"). */
export const loadLastFix = () => read<{ lat: number; lon: number }>("nw.lastFix");
export function saveLastFix(p: { lat: number; lon: number }): void { write("nw.lastFix", { lat: p.lat, lon: p.lon }); }

/** A fresh GPS fix for SOS, or null within the time limit. */
export async function freshFix(timeoutMs = 5000): Promise<{ lat: number; lon: number } | null> {
  const fix = Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 20000 }).catch(() => null);
  const pos = await Promise.race([fix, new Promise<null>((r) => window.setTimeout(() => r(null), timeoutMs + 500))]);
  return pos ? { lat: pos.coords.latitude, lon: pos.coords.longitude } : null;
}

export async function loadLang(): Promise<Lang> { return (await read<Lang>("nw.lang")) === "hi" ? "hi" : "en"; }
export function saveLang(l: Lang): void { write("nw.lang", l); }

/** The last plan: what was asked, which way was shown, and whether the trip had started. */
export interface SavedTrip { ask: TripAsk; option: string; started: boolean }
export const lastTrip = () => read<SavedTrip>("nw.trip");
export function rememberTrip(t: SavedTrip | null): void { write("nw.trip", t); }

/** "My location": the phone's GPS if it is inside (or near) a zone of the area, else the demo start point. */
export async function myLocation(defaults: UiDefaults): Promise<Place> {
  const demo: Place = { ...defaults.start, kind: "here", demo: true };
  const fix = Geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 }).catch(() => null);
  const pos = await Promise.race([fix, new Promise<null>((r) => window.setTimeout(() => r(null), 5000))]);
  if (!pos) return demo;
  const { latitude: lat, longitude: lon } = pos.coords;
  saveLastFix({ lat, lon });
  return (await call("inArea", lat, lon).catch(() => false)) ? { lat, lon, name: "", kind: "here" } : demo;
}

// Where the phone is during a trip: real GPS (Capacitor Geolocation watch) or the Demo's fake GPS
// ("Walk the way" / "Wander off", clearly marked simulated). The deviation warning listens here.
import { Geolocation } from "@capacitor/geolocation";
import { useEffect, useState } from "react";
import { CONFIG } from "../config";
import { nearestOnPath, type Fix, type LatLon } from "../engine/deviation";

const subs = new Set<(f: Fix) => void>();
const emit = (f: Fix) => subs.forEach((s) => s(f));
export function onFix(f: (fix: Fix) => void): () => void { subs.add(f); return () => { subs.delete(f); }; }

// ---- Demo fake GPS --------------------------------------------------------------------------------
interface Fake { path: LatLon[]; along: number; speed: number; offsetM: number; timer: number; spot: LatLon | null }
let fake: Fake | null = null;
const fakeWatchers = new Set<() => void>();
const changed = () => fakeWatchers.forEach((f) => f());

function pointAlong(path: LatLon[], m: number, offsetM: number): LatLon {
  const kx = 111320 * Math.cos((path[0][0] * Math.PI) / 180), ky = 110540;
  let left = m;
  for (let i = 0; i + 1 < path.length; i++) {
    const [a, b] = [path[i], path[i + 1]];
    const dx = (b[1] - a[1]) * kx, dy = (b[0] - a[0]) * ky, L = Math.hypot(dx, dy);
    if (left <= L || i + 2 === path.length) {
      const k = L ? Math.min(1, left / L) : 0;
      const nx = L ? -dy / L : 0, ny = L ? dx / L : 0;          // to the left of the way
      return [a[0] + (k * dy + ny * offsetM) / ky, a[1] + (k * dx + nx * offsetM) / kx];
    }
    left -= L;
  }
  return path[path.length - 1];
}

export const fakeGps = {
  running: () => !!fake,
  offsetM: () => fake?.offsetM ?? 0,
  /** Walk the way at 1.3 m/s × speed, one fix per CONFIG.deviation.fakeStepMs. */
  walk(path: LatLon[], speed = 1): void {
    if (path.length < 2) return;
    fakeGps.stop();
    const step = CONFIG.deviation.fakeStepMs;
    const f: Fake = { path, along: 0, speed, offsetM: 0, timer: 0, spot: null };
    f.timer = window.setInterval(() => {
      if (!f.spot) f.along += 1.3 * f.speed * (step / 1000);
      const [lat, lon] = f.spot ?? pointAlong(f.path, f.along, 0);
      emit({ lat, lon, accuracy: 8, t: Date.now() });
    }, step);
    fake = f;
    changed();
  },
  /** Jump the fake position this far off the way and stay there (0 = back on the way). The side is the
   *  one farther from the whole way, so a winding street does not pass close by again. */
  wander(m: number): void {
    if (!fake) return;
    fake.offsetM = m;
    if (m <= 0) { fake.spot = null; changed(); return; }
    const sides = [m, -m].map((o) => pointAlong(fake!.path, fake!.along, o));
    fake.spot = sides.reduce((a, b) => (nearestOnPath(fake!.path, ...b).distM > nearestOnPath(fake!.path, ...a).distM ? b : a));
    changed();
  },
  /** After "New way": follow the new way from its start, back on the line. */
  follow(path: LatLon[]): void { if (fake && path.length >= 2) { fake.path = path; fake.along = 0; fake.offsetM = 0; fake.spot = null; changed(); } },
  stop(): void { if (fake) window.clearInterval(fake.timer); fake = null; changed(); },
  watch(f: () => void): () => void { fakeWatchers.add(f); return () => { fakeWatchers.delete(f); }; },
};

/** The latest fix during a trip. Real GPS only when `useGps` (the trip started from a real fix inside the
 *  area); the Demo's fake GPS whenever it runs. */
export function usePosition(active: boolean, useGps: boolean): Fix | null {
  const [fix, setFix] = useState<Fix | null>(null);
  useEffect(() => onFix(setFix), []);
  useEffect(() => {
    if (!active || !useGps) return;
    let id: string | null = null, stop = false;
    Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }, (pos) => {
      if (pos && !fake) emit({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, t: Date.now() });
    }).then((w) => { if (stop) Geolocation.clearWatch({ id: w }).catch(() => {}); else id = w; }).catch(() => {});
    return () => { stop = true; if (id) Geolocation.clearWatch({ id }).catch(() => {}); };
  }, [active, useGps]);
  useEffect(() => { if (!active) setFix(null); }, [active]);
  return active ? fix : null;
}

export function useFakeGps(): boolean {
  const [on, setOn] = useState(fakeGps.running());
  useEffect(() => fakeGps.watch(() => setOn(fakeGps.running())), []);
  return on;
}

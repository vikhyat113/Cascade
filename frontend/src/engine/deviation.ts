// Route deviation warning (UPGRADE §7), on-device. Compares GPS fixes with the planned way:
// distance to the nearest point of the polyline + progress along it, with hysteresis so normal GPS
// jitter never warns. Levels: "off" (gentle) and "far" (strong); "still" when the user has not moved
// for a long time at night. Pure logic: the app feeds it fixes (real GPS or the Demo's fake GPS).
import { CONFIG } from "../config";

export type LatLon = [number, number];
export interface Fix { lat: number; lon: number; accuracy: number; t: number }
export type DeviationLevel = "ok" | "off" | "far";
export interface DeviationState { level: DeviationLevel; distM: number; progress: number; still: boolean; snoozedUntil: number | null }

/** Distance (m) from a point to a polyline, the index of the nearest segment, and the share of the
 *  way already covered (0..1). Local equirectangular metres around the point. */
export function nearestOnPath(path: LatLon[], lat: number, lon: number): { distM: number; seg: number; progress: number } {
  if (!path.length) return { distM: Infinity, seg: -1, progress: 0 };
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110540;
  const xy = (p: LatLon) => [(p[1] - lon) * kx, (p[0] - lat) * ky] as const;
  if (path.length === 1) { const [x, y] = xy(path[0]); return { distM: Math.hypot(x, y), seg: 0, progress: 0 }; }
  let best = Infinity, bestSeg = 0, bestAlong = 0, total = 0;
  const cum: number[] = [0];
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, ay] = xy(path[i]), [bx, by] = xy(path[i + 1]);
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    const k = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (L * L))) : 0;
    const d = Math.hypot(ax + k * dx, ay + k * dy);
    if (d < best) { best = d; bestSeg = i; bestAlong = cum[i] + k * L; }
    total += L;
    cum.push(total);
  }
  return { distM: best, seg: bestSeg, progress: total ? bestAlong / total : 0 };
}

export class DeviationMonitor {
  private bad = 0;                  // consecutive fixes beyond the "off" threshold
  private good = 0;
  private offSince: number | null = null;   // first fix of the current streak beyond the line
  private lastMove: { lat: number; lon: number; t: number } | null = null;
  state: DeviationState = { level: "ok", distM: 0, progress: 0, still: false, snoozedUntil: null };

  constructor(private cfg = CONFIG.deviation) {}

  /** Feed one fix; returns the new state. `vehicle` = the current step is a bus / metro ride. */
  update(fix: Fix, path: LatLon[], vehicle: boolean, night: boolean): DeviationState {
    const c = this.cfg;
    const st = { ...this.state };
    if (fix.accuracy > c.maxAccuracyM) return this.state;        // a poor fix says nothing
    const { distM, progress } = nearestOnPath(path, fix.lat, fix.lon);
    st.distM = Math.round(distM);
    st.progress = progress;
    const offM = vehicle ? c.offVehicleM : c.offM, farM = vehicle ? c.farVehicleM : c.farM;
    if (distM > offM) { if (this.bad === 0) this.offSince = fix.t; this.bad++; this.good = 0; } else { this.good++; this.bad = 0; }
    if (this.bad >= c.consecutive) {
      const offFor = fix.t - (this.offSince ?? fix.t);
      if (distM > farM || offFor > c.farAfterS * 1000) st.level = "far";
      else if (offFor >= c.offAfterS * 1000 || st.level === "off") st.level = "off";
    } else if (this.good >= c.backAfter) {
      st.level = "ok";
      this.offSince = null;
    }
    // standing still for a long time at night (not on a ride)
    if (!this.lastMove || Math.hypot((fix.lat - this.lastMove.lat) * 110540, (fix.lon - this.lastMove.lon) * 111320 * Math.cos((fix.lat * Math.PI) / 180)) > c.stillMoveM) {
      this.lastMove = { lat: fix.lat, lon: fix.lon, t: fix.t };
      st.still = false;
    } else if (night && !vehicle && fix.t - this.lastMove.t > c.stillAfterS * 1000) {
      st.still = true;
    }
    this.state = st;
    return st;
  }

  /** What to show now. "I'm fine" quiets the gentle warning for a while; being far from the way is a
   *  different situation and is always shown. */
  shown(now: number): DeviationLevel {
    if (this.state.level === "off" && this.state.snoozedUntil && now < this.state.snoozedUntil) return "ok";
    return this.state.level;
  }

  snooze(now: number): void { this.state = { ...this.state, snoozedUntil: now + this.cfg.snoozeS * 1000 }; }
  okStill(now: number): void { this.lastMove = this.lastMove ? { ...this.lastMove, t: now } : null; this.state = { ...this.state, still: false }; }
  reset(): void { this.bad = this.good = 0; this.offSince = null; this.lastMove = null; this.state = { level: "ok", distM: 0, progress: 0, still: false, snoozedUntil: null }; }
}

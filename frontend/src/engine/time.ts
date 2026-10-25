// The one app clock (spec §7.1). All night logic reads clock.now(), never Date.now(), so a
// daytime demo can be set to "2:15 AM" and run at 1x / 10x / 60x.

export interface Clock { now(): number; speed: number; paused: boolean; set(o: { time?: number; speed?: number; paused?: boolean }): void; advance(s: number): void }

export class AppClock implements Clock {
  private anchorSim: number;
  private anchorReal: number;
  speed: number;
  paused: boolean;
  constructor(start = Date.now(), speed = 1, paused = false, private realNow: () => number = () => Date.now()) {
    this.anchorSim = start;
    this.anchorReal = realNow();
    this.speed = speed;
    this.paused = paused;
  }
  now(): number {
    return this.paused ? this.anchorSim : this.anchorSim + (this.realNow() - this.anchorReal) * this.speed;
  }
  set(o: { time?: number; speed?: number; paused?: boolean }): void {
    const cur = this.now();
    if (o.speed !== undefined) this.speed = Math.max(0, o.speed);
    if (o.paused !== undefined) this.paused = o.paused;
    this.anchorSim = o.time ?? cur;
    this.anchorReal = this.realNow();
  }
  advance(s: number): void { this.set({ time: this.now() + s * 1000 }); }
}

/** Deterministic clock for tests and scenario replay. */
export class ManualClock implements Clock {
  speed = 0;
  paused = true;
  constructor(private t: number) {}
  now(): number { return this.t; }
  set(o: { time?: number }): void { if (o.time !== undefined) this.t = o.time; }
  advance(s: number): void { this.t += s * 1000; }
}

// ---- city-local time (fixed offset, e.g. India +05:30: no daylight saving) -------------------------
export class CityTime {
  constructor(public offsetMin: number) {}
  private d(ms: number): Date { return new Date(ms + this.offsetMin * 60000); }
  hour(ms: number): number { return this.d(ms).getUTCHours(); }
  minute(ms: number): number { return this.d(ms).getUTCMinutes(); }
  /** Monday = 0 … Sunday = 6 */
  weekday(ms: number): number { return (this.d(ms).getUTCDay() + 6) % 7; }
  /** "2:58" (night times are read without am/pm) */
  clock(ms: number | null | undefined): string | null {
    if (ms == null) return null;
    const d = this.d(ms);
    return `${d.getUTCHours() % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }
  hhmm(ms: number | null | undefined): string {
    if (ms == null) return "--:--";
    const d = this.d(ms);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }
  hourKey(ms: number): string {
    const d = this.d(ms);
    return `${d.toISOString().slice(0, 13)}`;             // city-local "YYYY-MM-DDTHH"
  }
  /** Local midnight that starts the calendar day containing ms (epoch ms). */
  dayStart(ms: number): number {
    const d = this.d(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - this.offsetMin * 60000;
  }
  /** Noon that starts the night containing ms ("tonight": 02:00 belongs to the previous evening). */
  nightStart(ms: number): number {
    const noon = this.dayStart(ms) + 12 * 3600000;
    return ms >= noon ? noon : noon - 86400000;
  }
  /** "02:15" on the night containing `ref`: 12:00-23:59 the same evening, 00:00-11:59 after midnight. */
  atNight(hhmm: string, ref: number): number {
    const m = /^(\d{1,2})[:.](\d{2})/.exec(hhmm.trim());
    if (!m) throw new Error(`bad time ${hhmm}`);
    const h = Number(m[1]);
    const mi = Number(m[2]);
    const night = this.nightStart(ref);                     // local noon
    const offset = (h >= 12 ? h - 12 : h + 12) * 3600000 + mi * 60000;
    return night + offset;
  }
}

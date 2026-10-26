import { describe, expect, it } from "vitest";
import { CONFIG } from "../../config";
import { DeviationMonitor, nearestOnPath, type LatLon } from "../deviation";
import { Rng } from "../util";

// a 1 km straight way going east at Sitabuldi, and helpers in metres
const LAT = 21.142, LON = 79.08, KX = 111320 * Math.cos((LAT * Math.PI) / 180), KY = 110540;
const at = (eastM: number, northM: number): LatLon => [LAT + northM / KY, LON + eastM / KX];
const PATH: LatLon[] = [at(0, 0), at(500, 0), at(1000, 0)];
const fix = (eastM: number, northM: number, t: number, accuracy = 10) => { const [lat, lon] = at(eastM, northM); return { lat, lon, accuracy, t }; };

describe("distance to the way", () => {
  it("measures metres off the line and progress along it", () => {
    const r = nearestOnPath(PATH, ...at(250, 80));
    expect(r.distM).toBeCloseTo(80, 0);
    expect(r.progress).toBeCloseTo(0.25, 2);
    expect(nearestOnPath(PATH, ...at(1200, 0)).distM).toBeCloseTo(200, 0);   // past the end
    expect(nearestOnPath(PATH, ...at(-30, 40)).distM).toBeCloseTo(50, 0);     // before the start
  });
});

describe("deviation warning", () => {
  it("stays quiet with normal GPS jitter (±25 m)", () => {
    const m = new DeviationMonitor(), rng = new Rng(5);
    for (let i = 0; i < 200; i++) expect(m.update(fix(i * 5, rng.uniform(-25, 25), i * 1000, rng.uniform(5, 40)), PATH, false, true).level).toBe("ok");
  });
  it("needs 3 fixes in a row AND 20 s beyond 60 m before 'off the way'", () => {
    const m = new DeviationMonitor();
    expect(m.update(fix(100, 90, 0), PATH, false, true).level).toBe("ok");
    expect(m.update(fix(105, 90, 5000), PATH, false, true).level).toBe("ok");
    expect(m.update(fix(110, 90, 10000), PATH, false, true).level).toBe("ok");      // 3 fixes, but only 10 s
    expect(m.update(fix(115, 90, 15000), PATH, false, true).level).toBe("ok");      // 15 s
    expect(m.update(fix(120, 90, 21000), PATH, false, true).level).toBe("off");     // 21 s
    expect(m.update(fix(125, 10, 35000), PATH, false, true).level).toBe("off");     // one good fix: not yet
    expect(m.update(fix(130, 10, 40000), PATH, false, true).level).toBe("ok");      // two: back on the way
  });
  it("ignores poor fixes (accuracy > 50 m)", () => {
    const m = new DeviationMonitor();
    for (let i = 0; i < 10; i++) expect(m.update(fix(100, 400, i * 10000, 80), PATH, false, true).level).toBe("ok");
  });
  it("says 'far' beyond 250 m, or after 3 min off the way", () => {
    const a = new DeviationMonitor();
    for (let i = 0; i < 3; i++) a.update(fix(100, 300, i * 2000), PATH, false, true);
    expect(a.state.level).toBe("far");
    const b = new DeviationMonitor();
    for (let i = 0; i <= 20; i++) b.update(fix(100, 100, i * 10000), PATH, false, true);
    expect(b.state.level).toBe("far");                                              // 100 m but for 200 s
  });
  it("uses a wider line on a bus or metro ride", () => {
    const m = new DeviationMonitor();
    for (let i = 0; i < 6; i++) m.update(fix(100, 120, i * 10000), PATH, true, true);
    expect(m.state.level).toBe("ok");
  });
  it("'I'm fine' snoozes warnings for 3 minutes", () => {
    const m = new DeviationMonitor();
    for (let i = 0; i < 5; i++) m.update(fix(100, 100, i * 10000), PATH, false, true);
    expect(m.shown(40000)).toBe("off");
    m.snooze(40000);
    expect(m.shown(40000 + 179000)).toBe("ok");
    expect(m.shown(40000 + CONFIG.deviation.snoozeS * 1000 + 1000)).not.toBe("ok");
  });
  it("still shows 'far' during a snooze", () => {
    const m = new DeviationMonitor();
    for (let i = 0; i < 5; i++) m.update(fix(100, 100, i * 10000), PATH, false, true);
    m.snooze(40000);
    for (let i = 5; i < 8; i++) m.update(fix(100, 400, i * 10000), PATH, false, true);
    expect(m.shown(80000)).toBe("far");
  });
  it("asks 'Are you OK?' after 5 min without moving at night, not by day or on a ride", () => {
    const night = new DeviationMonitor(), day = new DeviationMonitor(), ride = new DeviationMonitor();
    for (let t = 0; t <= 310000; t += 10000) { night.update(fix(200, 3, t), PATH, false, true); day.update(fix(200, 3, t), PATH, false, false); ride.update(fix(200, 3, t), PATH, true, true); }
    expect(night.state.still).toBe(true);
    expect(day.state.still).toBe(false);
    expect(ride.state.still).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { planFull } from "../planner";
import { validatePlanSet } from "../validate";
import { testEngine, workHome } from "./world.fixture";

describe("planner on the bundled city", () => {
  it("gives labelled options with ordered ranges and an explanation", () => {
    const e = testEngine();
    const t = Date.now();
    const { ps } = planFull(e.state, workHome(e), e.cache);
    expect(Date.now() - t).toBeLessThan(5000);
    const labels = new Set(ps.plans.flatMap((p) => p.labels));
    for (const l of ["Recommended", "Fastest", "Safest"]) expect(labels.has(l)).toBe(true);
    for (const p of ps.plans) {
      expect(p.eta.best! <= p.eta.expected!).toBe(true);
      if (p.eta.worst) expect(p.eta.expected! <= p.eta.worst).toBe(true);
      expect(p.safety.lo).toBeLessThanOrEqual(p.safety.hi);
      expect(p.explanation.length).toBeGreaterThan(5);
    }
    expect(validatePlanSet(ps)).toEqual([]);
  });

  it("safest walk is at least as safe as the fastest walk", () => {
    const e = testEngine();
    const { all } = planFull(e.state, workHome(e, { modes: ["walk"] }), e.cache);
    const walks = all.filter((p) => p.kind === "walk");
    const fastest = walks.reduce((a, b) => ((b.durationMin.expected ?? 1e9) < (a.durationMin.expected ?? 1e9) ? b : a));
    const safest = walks.reduce((a, b) => (b.safety.lo > a.safety.lo ? b : a));
    expect(safest.safety.lo).toBeGreaterThanOrEqual(fastest.safety.lo);
    expect(fastest.durationMin.expected!).toBeLessThanOrEqual(safest.durationMin.expected!);
  });

  it("falls back to the timetable when bus info dies (simulated night buses)", () => {
    const e = testEngine();
    e.state.pretendNightBuses = true;
    e.outage("transit_realtime", false);
    e.advance(120 * 11);
    const { all } = planFull(e.state, workHome(e, { modes: ["walk", "bus"], finish: "02:20", by: "03:30", along: "bus" }), e.cache);
    const bus = all.filter((p) => p.kind === "bus");
    expect(bus.length).toBeGreaterThan(0);
    const tt = bus[0].trust.categories.find((c) => c.name === "transit_timing")!;
    expect(tt.status).toBe("PROBABLE");
    expect(tt.detail).toContain("timetable");
  });

  it("never invents night service: routes with unknown hours are UNKNOWN, with no worst case", () => {
    const e = testEngine();
    const { all } = planFull(e.state, workHome(e, { modes: ["walk", "bus"], finish: "02:20", by: "03:30", along: "bus" }), e.cache);
    const bus = all.filter((p) => p.kind === "bus");
    expect(bus.length).toBeGreaterThan(0);
    for (const p of bus) {
      expect(p.trust.categories.find((c) => c.name === "transit_timing")!.status).toBe("UNKNOWN");
      expect(p.eta.worst).toBeNull();
      expect(p.feasible.worst).toBe(false);
    }
  });

  it("finds a way with changes when no single route connects (IIIT Nagpur -> Dharampeth)", () => {
    const e = testEngine();
    e.state.pretendNightBuses = true;
    const w = e.world, d = w.meta.ui_defaults;
    const t = Date.now();
    const { all } = planFull(e.state, { ...workHome(e, { modes: ["walk", "bus"], finish: "23:00", by: "02:30" }), origin: { ...d.start, kind: null } }, e.cache);
    expect(Date.now() - t).toBeLessThan(1500);
    const multi = all.filter((p) => p.segments.filter((s) => s.mode === "bus" || s.mode === "metro").length >= 2);
    expect(multi.length).toBeGreaterThan(0);
    const steps = multi[0].segments.filter((s) => s.mode === "wait");
    expect(steps.slice(1).every((s) => s.change)).toBe(true);
  });

  it("re-plans from a point off the way (deviation 'New way')", () => {
    const e = testEngine();
    const req = workHome(e, { modes: ["walk"] });
    const off = { lat: req.origin.lat + 300 / 110540, lon: req.origin.lon, name: "", kind: null };   // 300 m north
    const { ps } = planFull(e.state, { ...req, origin: off }, e.cache);
    const rec = ps.plans.find((p) => p.id === ps.recommendedId)!;
    expect(rec).toBeTruthy();
    const [la, lo] = rec.segments[0].coords[0];
    expect(Math.hypot((la - off.lat) * 110540, (lo - off.lon) * 103900)).toBeLessThan(5);
  });

  it("still plans with all live info lost, with lower confidence and nothing invented", () => {
    const e = testEngine();
    const req = workHome(e, { finish: "02:10", by: "04:00" });
    const before = planFull(e.state, req, e.cache).ps;
    e.outage("all_live", false);
    e.advance(3600);
    const after = planFull(e.state, req, e.cache).ps;
    const rb = before.plans.find((p) => p.id === before.recommendedId)!;
    const ra = after.plans.find((p) => p.id === after.recommendedId)!;
    expect(ra.trust.confidence).toBeLessThan(rb.trust.confidence);
    expect(["OUTDATED", "UNKNOWN"]).toContain(ra.trust.status);
    expect(validatePlanSet(after)).toEqual([]);
  });

  it("re-plans when a closure blocks the walking way, and logs why", () => {
    const e = testEngine();
    const ap = e.plan(workHome(e, { modes: ["walk"] }));
    const rec = ap.planset!.plans.find((p) => p.id === ap.planset!.recommendedId)!;
    e.choose(rec.id);
    e.inject({ type: "road_closure", params: { edge_selector: "main_road_nearest_route" } });
    e.advance(60);
    expect(ap.log.map((x) => x.kind)).toContain("event");
    const blocked = ap.log.some((x) => x.kind === "switch" && x.code === "switch.closure");
    const crosses = rec.segments.some((sg) => sg.mode === "walk" && sg.label.includes(" via "));
    if (blocked) expect(ap.planset!.recommendedId).not.toBe(rec.id);
    expect(blocked || !crosses).toBe(true);
  });

  it("hysteresis keeps the plan on small changes", () => {
    const e = testEngine();
    const ap = e.plan(workHome(e));
    const first = ap.planset!.recommendedId;
    for (let i = 0; i < 5; i++) e.advance(30);
    expect(ap.planset!.recommendedId).toBe(first);
    expect(ap.log.filter((x) => x.kind === "switch")).toEqual([]);
  });
});

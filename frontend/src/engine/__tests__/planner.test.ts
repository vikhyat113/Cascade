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

  it("falls back to the timetable when bus info dies", () => {
    const e = testEngine();
    e.outage("transit_realtime", false);
    e.advance(120 * 11);
    const { all } = planFull(e.state, workHome(e, { modes: ["walk", "bus"], finish: "02:20", by: "03:30", along: "bus" }), e.cache);
    const bus = all.filter((p) => p.kind === "bus");
    expect(bus.length).toBeGreaterThan(0);
    const tt = bus[0].trust.categories.find((c) => c.name === "transit_timing")!;
    expect(tt.status).toBe("PROBABLE");
    expect(tt.detail).toContain("timetable");
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

  it("re-plans when a closure breaks the cab way, and logs why", () => {
    const e = testEngine();
    const ap = e.plan(workHome(e, { modes: ["walk", "cab"] }));
    const rec = ap.planset!.plans.find((p) => p.id === ap.planset!.recommendedId)!;
    e.inject({ type: "road_closure", params: { edge_selector: "main_road_nearest_route" } });
    e.advance(60);
    const kinds = ap.log.map((x) => x.kind);
    expect(kinds).toContain("event");
    if (rec.kind === "cab") {
      expect(ap.planset!.recommendedId).not.toBe(rec.id);
      expect(ap.log.some((x) => x.kind === "switch" && x.code === "switch.closure")).toBe(true);
    }
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

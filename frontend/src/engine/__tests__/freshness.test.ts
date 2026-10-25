import { describe, expect, it } from "vitest";
import { CONFIG } from "../../config";
import { aggregate, confidence, coverageStatus, status, view, type Fact } from "../freshness";
import { isOpen, parseHours } from "../hours";

const NOW = Date.UTC(2026, 9, 26, 2, 0);
const fact = (ageS = 0, o: Partial<Fact> = {}): Fact => ({ key: "t", value: 1, source: "test", synthetic: true, observedAt: NOW - ageS * 1000, ttlS: 120, reliability: 0.9, kind: "observed", ...o });

describe("the four statuses", () => {
  it("KNOWN: fresh, observed, reliable", () => {
    expect(status(fact(60), NOW)).toBe("KNOWN");
    expect(status(fact(120), NOW)).toBe("KNOWN");
  });
  it("PROBABLE: slightly stale, unreliable, or scheduled / inferred / prior", () => {
    expect(status(fact(121), NOW)).toBe("PROBABLE");
    expect(status(fact(360), NOW)).toBe("PROBABLE");
    expect(status(fact(10, { reliability: 0.6 }), NOW)).toBe("PROBABLE");
    for (const kind of ["scheduled", "inferred", "prior"] as const) expect(status(fact(100, { kind, ttlS: 3600 }), NOW)).toBe("PROBABLE");
  });
  it("OUTDATED: old or contradicted", () => {
    expect(status(fact(361), NOW)).toBe("OUTDATED");
    expect(status(fact(7200, { kind: "scheduled", ttlS: 3600 }), NOW)).toBe("OUTDATED");
    expect(status(fact(5, { kind: "scheduled", ttlS: 3600, contradictedBy: "rt:1" }), NOW)).toBe("OUTDATED");
  });
  it("UNKNOWN: missing, null or unusably old - and the view never carries a value", () => {
    expect(status(null, NOW)).toBe("UNKNOWN");
    expect(status(fact(0, { value: null }), NOW)).toBe("UNKNOWN");
    expect(status(fact(1201), NOW)).toBe("UNKNOWN");
    const v = view(fact(99999), NOW);
    expect([v.status, v.value, v.confidence]).toEqual(["UNKNOWN", null, 0]);
    expect(view(null, NOW, { key: "weather", interval: [0, 0.7] })).toMatchObject({ status: "UNKNOWN", value: null, interval: [0, 0.7] });
  });
});

describe("confidence decay", () => {
  it("decays monotonically and starts at reliability", () => {
    const c = [0, 30, 60, 120, 240, 360, 600, 1199].map((a) => confidence(fact(a), NOW));
    c.slice(1).forEach((v, i) => expect(v).toBeLessThanOrEqual(c[i]));
    expect(c[0]).toBeCloseTo(0.9, 3);
    expect(c[3]).toBeCloseTo(0.9 * Math.exp(-1 / CONFIG.freshness.decayScale), 3);
  });
  it("matches the literal exp(-age/ttl) with decayScale 1", () => {
    expect(confidence(fact(120), NOW, { ...CONFIG.freshness, decayScale: 1 })).toBeCloseTo(0.9 * Math.exp(-1), 3);
  });
  it("is capped by kind and halved when OUTDATED", () => {
    expect(confidence(fact(0, { kind: "prior", reliability: 1, ttlS: 1e6 }), NOW)).toBeLessThanOrEqual(0.4);
    const fresh = 0.9 * Math.exp(-(361 / 120) / CONFIG.freshness.decayScale);
    expect(confidence(fact(361), NOW)).toBeCloseTo(fresh * 0.5, 3);
  });
});

describe("aggregation", () => {
  it("is weakest link + confidence product", () => {
    const a = fact(0), b = fact(200);
    const agg = aggregate([a, b], NOW);
    expect(agg.status).toBe("PROBABLE");
    expect(agg.confidence).toBeCloseTo(confidence(a, NOW) * confidence(b, NOW), 3);
    expect(aggregate([a, null], NOW).status).toBe("UNKNOWN");
  });
  it("covers a way by length share", () => {
    expect(coverageStatus({ KNOWN: 0.9, PROBABLE: 0, OUTDATED: 0, UNKNOWN: 0.1 })).toBe("KNOWN");
    expect(coverageStatus({ KNOWN: 0.6, PROBABLE: 0, OUTDATED: 0, UNKNOWN: 0.4 })).toBe("UNKNOWN");
    expect(coverageStatus({ KNOWN: 0.6, PROBABLE: 0.2, OUTDATED: 0, UNKNOWN: 0.2 })).toBe("PROBABLE");
  });
});

describe("opening hours", () => {
  it("reads common patterns and fails safely", () => {
    expect(parseHours("24/7")!.always).toBe(true);
    const night = parseHours("Mo-Fr 08:30-05:00")!;
    expect(isOpen(night, 1, 150)).toBe(true);           // Tue 02:30 <- Monday evening
    expect(isOpen(night, 0, 150)).toBe(false);          // Mon 02:30 <- Sunday not listed
    const two = parseHours("Mo-Fr 09:00-17:00; We off")!;
    expect(isOpen(two, 2, 600)).toBe(false);
    for (const bad of [null, "", "sunrise-sunset", "Mo-Fr 10:00+", "by appointment"]) expect(parseHours(bad)).toBeNull();
  });
});

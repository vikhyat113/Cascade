import { describe, expect, it } from "vitest";
import graph from "../../data/graph.json";
import incidents from "../../data/incidents.json";
import meta from "../../data/meta.json";
import places from "../../data/places.json";
import pois from "../../data/pois.json";
import schedule from "../../data/schedule.json";
import weather from "../../data/weather.json";
import { CONFIG } from "../../config";
import { CODE } from "../freshness";
import { LIGHT_SRC, World, type Bundle } from "../world";

const bundle = { graph, pois, places, weather, incidents, schedule, meta } as unknown as Bundle;
const unknownShare = (w: World) => { let u = 0, t = 0; for (let e = 0; e < w.m; e++) { t += w.elen[e]; if (w.lightCode[e] === CODE.UNKNOWN) u += w.elen[e]; } return u / t; };

describe("lighting prior from satellite night lights", () => {
  it("lowers the share of streets with unknown lighting, and is never KNOWN", () => {
    const keep = CONFIG.risk.viirsPrior;
    try {
      CONFIG.risk.viirsPrior = false;
      const off = new World(bundle);
      CONFIG.risk.viirsPrior = true;
      const on = new World(bundle);
      expect(unknownShare(on)).toBeLessThan(unknownShare(off) - 0.2);
      let sat = 0;
      for (let e = 0; e < on.m; e++) if (on.lightSrc[e] === LIGHT_SRC.satellite) { sat++; expect(on.lightCode[e]).toBe(CODE.PROBABLE); }
      expect(sat).toBeGreaterThan(0);
      for (let e = 0; e < off.m; e++) expect(off.lightSrc[e]).not.toBe(LIGHT_SRC.satellite);
    } finally { CONFIG.risk.viirsPrior = keep; }
  });
  it("never overrides mapped lighting or the main-road prior", () => {
    const w = new World(bundle);
    for (let e = 0; e < w.m; e++) {
      if (graph.edges.lit[e] !== -1 || graph.edges.lamps[e] > 0) expect(w.lightSrc[e]).toBe(LIGHT_SRC.mapped);
    }
  });
});

describe("moon light (computed, not measured)", async () => {
  const { moonLight } = await import("../astronomy");
  it("knows new and full moons", () => {
    expect(moonLight(Date.UTC(2024, 3, 8, 18, 0), 21.14, 79.08).fraction).toBeLessThan(0.03);     // new moon (8 Apr 2024)
    expect(moonLight(Date.UTC(2024, 3, 23, 23, 0), 21.14, 79.08).fraction).toBeGreaterThan(0.97); // full moon (23-24 Apr 2024)
  });
  it("says 'none' when the moon is down, even at full moon", () => {
    // full moon 23 Apr 2024: it rises near sunset and sets near sunrise, so at local noon it is down
    const noon = moonLight(Date.UTC(2024, 3, 24, 6, 30), 21.14, 79.08);
    expect(noon.up).toBe(false);
    expect(noon.level).toBe("none");
    const midnight = moonLight(Date.UTC(2024, 3, 23, 18, 30), 21.14, 79.08);
    expect(midnight.up).toBe(true);
    expect(midnight.level).toBe("bright");
  });
});

describe("safety heat (estimate)", async () => {
  const { heatmap } = await import("../heatmap");
  it("covers the streets with values 0..1 and changes with the hour", () => {
    const w = new World(bundle);
    const h2 = heatmap(w, 2), h22 = heatmap(w, 22);
    expect(h2.length).toBeGreaterThan(500);
    for (const [s, wst, n, e, v] of h2) { expect(n).toBeGreaterThan(s); expect(e).toBeGreaterThan(wst); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    const sum = (a: number[][]) => a.reduce((x, c) => x + c[4], 0);
    expect(sum(h2)).not.toBeCloseTo(sum(h22), 0);
  });
});

import { describe, expect, it } from "vitest";
import { nearest } from "../services";
import { Rng } from "../util";

describe("nearest open place (grid search)", () => {
  it("matches brute force within the 3.5 km cap, and says 'none' beyond it", () => {
    const rng = new Rng(3);
    const pts = Array.from({ length: 300 }, () => ({ p: { x: rng.uniform(-8000, 8000), y: rng.uniform(-8000, 8000) } }));
    const xs = Float64Array.from({ length: 2000 }, () => rng.uniform(-14000, 14000));
    const ys = Float64Array.from({ length: 2000 }, () => rng.uniform(-14000, 14000));
    const [d, idx] = nearest(xs, ys, pts as never);
    for (let i = 0; i < xs.length; i++) {
      let best = Infinity, bi = -1;
      pts.forEach((q, k) => { const dd = Math.hypot(q.p.x - xs[i], q.p.y - ys[i]); if (dd < best) { best = dd; bi = k; } });
      if (best < 3500) { expect(d[i]).toBeCloseTo(best, 6); expect(idx[i]).toBe(bi); }
      else { expect(d[i]).toBe(1e5); expect(idx[i]).toBe(-1); }
    }
  });
});

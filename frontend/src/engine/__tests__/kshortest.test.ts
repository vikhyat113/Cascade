// Golden tests: the TypeScript port must give the same answers as the original Python (routing.py
// from the `changes` branch), run by tools/golden_routing.py on a seeded sample graph.
import { describe, expect, it } from "vitest";
import golden from "./fixtures/routing_golden.json";
import { compareWays, computeEdgeCost, unknownShareOf, yenKShortest, type CandidateMetrics, type RGraph } from "../kshortest";

const G = golden.graph;
const n = G.x.length, m = G.u.length;
const adj: [number, number, boolean][][] = Array.from({ length: n }, () => []);
for (let e = 0; e < m; e++) { adj[G.u[e]].push([G.v[e], e, false]); adj[G.v[e]].push([G.u[e], e, true]); }
const graph: RGraph = {
  m, elen: G.len, adj: (u) => adj[u], nx: G.x, ny: G.y,
  emx: G.u.map((u, e) => (G.x[u] + G.x[G.v[e]]) / 2), emy: G.u.map((u, e) => (G.y[u] + G.y[G.v[e]]) / 2),
};
const blocked = new Uint8Array(m);
for (const e of golden.er.blocked) blocked[e] = 1;
const W = [0.24, 0.24, 0.2, 0.1, 0.1, 0.12];
const cost = (lam: number, u: number) => computeEdgeCost(graph, (c, e) => golden.er.lo[c][e], (c, e) => golden.er.hi[c][e], W, blocked,
  { walkFactor: golden.er.walk_factor, speed: 1.25, lam, u });

describe("safety-aware edge cost = Python", () => {
  it.each([[0, 0.5], [1, 0.5], [2, 0.8]])("lambda %s, u %s", (lam, u) => {
    const want = (golden.costs as Record<string, number[]>)[`${lam.toFixed(1)}-${u}`];
    const got = cost(lam, u);
    for (let e = 0; e < m; e++) expect(got[e]).toBeCloseTo(want[e], 6);
  });
});

describe("Yen's K-shortest loopless paths = Python", () => {
  const c = cost(1, 0.5);
  it.each(golden.yen.map((q) => [`${q.src} -> ${q.dst}`, q] as const))("%s: same paths, same order, same costs", (_n, q) => {
    const r = yenKShortest(graph, q.src, q.dst, c, blocked, { maxK: 12, timeBudgetMs: 30000, corridorM: 300, overlapMax: 0.7, costRatioMax: 1.6, diverseN: 4 });
    const flat = (ps: { cost: number; edges: (number | boolean)[][] }[]) => ps.map((p) => p.edges.map(([e, rev]) => `${e}${rev ? "r" : ""}`).join(","));
    expect(flat(r.all)).toEqual(flat(q.all as never));
    expect(flat(r.kept)).toEqual(flat(q.kept as never));
    r.all.forEach((p, i) => expect(p.cost).toBeCloseTo(q.all[i].cost, 6));
    expect(r.hitBudget).toBe(q.hit_budget);
  });
});

describe("comparing candidate ways = Python", () => {
  const C = golden.compare;
  const plans: CandidateMetrics[] = C.plans.map((p) => ({
    id: p.id, durationMin: p.duration_min, safety: p.safety, outdoorMin: p.outdoor_min,
    lightingDetail: p.trust.categories[0].detail, havenDistM: p.safe_havens.length ? p.safe_havens[0].dist_m : null,
    feasibleWorst: p.feasible.worst, worstEta: Date.parse(p.eta.worst), limitingStatus: p.trust.status,
  }));
  const r = compareWays(plans, Date.parse(C.deadline));
  it("same scores, dominance, feasibility, recommendation", () => {
    for (const want of C.routes) {
      const got = r.ways.find((w) => w.id === want.id)!;
      expect({ id: got.id, label: got.label, dominated: got.dominated, inf: got.infeasibleWorst, score: got.score, rec: got.recommended, slack: got.slackMin, unk: got.unknownShare, sh: got.havenDistM })
        .toEqual({ id: want.id, label: want.label, dominated: want.dominated, inf: want.infeasible_worst, score: want.score, rec: want.recommended, slack: want.slack_min, unk: want.unknown_lighting_share, sh: want.safe_haven_dist_m });
    }
  });
  it("same explanations and tie note", () => {
    for (const want of C.routes) {
      const got = r.ways.find((w) => w.id === want.id)!;
      expect(got.why).toBe(want.why);
      expect(got.lossReason).toBe(want.loss_reason);
    }
    expect(r.tie).toBe(C.meta.tie);
    expect(r.note).toBe(C.meta.note);
  });
});

describe("deviation from the Python (documented)", () => {
  it("reads the no-data share in the planner's own wording", () => {
    expect(unknownShareOf("5% mapped, 20% main roads, 30% satellite, 40% no data")).toBe(0.4);   // the Python returned 0 here
    expect(unknownShareOf("5% mapped, no data 40%")).toBe(0.4);
    expect(unknownShareOf(null)).toBe(0);
  });
});

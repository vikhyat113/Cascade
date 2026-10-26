// Multi-route engine (UPGRADE §4): a TypeScript port of the `changes` branch's routing.py
// (legacy/reference/routing_from_changes.py): safety-aware edge cost, Dijkstra, Yen's K-shortest
// loopless paths with a corridor limit and a diversity filter, and the transparent comparison of
// candidate ways (hard feasibility filter, Pareto dominance, weighted score, honest tie detection).
// Golden tests (kshortest.test.ts) check it against the Python on a seeded sample graph.
// Ported faithfully, including tie-breaking (Python heapq tuple order).

export const BLOCKED_COST = 1e12;
export type PathEdge = [number, boolean];                  // edge id, travelled against its u -> v direction
export interface KPath { cost: number; edges: PathEdge[]; nodes: number[] }

/** What the search needs from a graph: lengths, neighbours (in a fixed order), node and edge positions. */
export interface RGraph {
  m: number; elen: ArrayLike<number>;
  adj: (u: number) => Iterable<[number, number, boolean]>;   // [v, edge id, rev]
  nx: ArrayLike<number>; ny: ArrayLike<number>;               // node x, y (m)
  emx: ArrayLike<number>; emy: ArrayLike<number>;             // edge midpoints (m)
}

// ---- cost -----------------------------------------------------------------------------------------
/** edge_cost = time_s + lambda * risk_effective * length_m * k_exposure, with
 *  risk_effective = (1 - u) * mid + u * hi over the weighted risk components. */
export function computeEdgeCost(g: { m: number; elen: ArrayLike<number> }, lo: (c: number, e: number) => number, hi: (c: number, e: number) => number,
  weights: number[], blocked: ArrayLike<number | boolean> | null, opt: { walkFactor: number; speed: number; lam: number; u: number; k?: number }): Float64Array {
  const tot = weights.reduce((a, b) => a + b, 0) || 1;
  const w = weights.map((x) => x / tot);
  const k = opt.k ?? 0.8;
  const speed = Math.max(opt.speed * opt.walkFactor, 0.2);
  const out = new Float64Array(g.m);
  for (let e = 0; e < g.m; e++) {
    let mid = 0, h = 0;
    for (let c = 0; c < w.length; c++) {
      const l = lo(c, e), hh = hi(c, e);
      mid += w[c] * (l + 0.6 * (hh - l));
      h += w[c] * hh;
    }
    const risk = (1 - opt.u) * mid + opt.u * h;
    let cost = g.elen[e] / speed + opt.lam * risk * g.elen[e] * k;
    if (blocked && blocked[e]) cost = BLOCKED_COST;
    out[e] = Math.max(cost, 0.01);
  }
  return out;
}

// ---- Dijkstra (single pair, the "spur" search) --------------------------------------------------------
/** Min-heap on (distance, node) like Python heapq on (d, u) tuples. */
class Heap {
  private d: number[] = []; private n: number[] = [];
  get size() { return this.d.length; }
  private less(i: number, j: number) { return this.d[i] < this.d[j] || (this.d[i] === this.d[j] && this.n[i] < this.n[j]); }
  private swap(i: number, j: number) { [this.d[i], this.d[j]] = [this.d[j], this.d[i]]; [this.n[i], this.n[j]] = [this.n[j], this.n[i]]; }
  push(d: number, n: number) {
    this.d.push(d); this.n.push(n);
    let i = this.d.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!this.less(i, p)) break; this.swap(i, p); i = p; }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.d[0], this.n[0]];
    const ld = this.d.pop()!, ln = this.n.pop()!;
    if (this.d.length) {
      this.d[0] = ld; this.n[0] = ln;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < this.d.length && this.less(l, s)) s = l;
        if (r < this.d.length && this.less(r, s)) s = r;
        if (s === i) break;
        this.swap(i, s); i = s;
      }
    }
    return top;
  }
}

export function dijkstraSpur(g: RGraph, src: number, dst: number, blockedNodes: Set<number>, blockedEdges: Uint8Array, cost: ArrayLike<number>): KPath | null {
  if (blockedNodes.has(src) || blockedNodes.has(dst)) return null;
  if (src === dst) return { cost: 0, edges: [], nodes: [src] };
  const dist = new Map<number, number>([[src, 0]]);
  const pred = new Map<number, [number, number, boolean]>();
  const pq = new Heap();
  pq.push(0, src);
  while (pq.size) {
    const [d, u] = pq.pop();
    if (d > (dist.get(u) ?? Infinity)) continue;
    if (u === dst) break;
    for (const [v, eid, rev] of g.adj(u)) {
      if (blockedNodes.has(v) || blockedEdges[eid]) continue;
      const nd = d + cost[eid];
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); pred.set(v, [u, eid, rev]); pq.push(nd, v); }
    }
  }
  if (!dist.has(dst)) return null;
  const edges: PathEdge[] = [], nodes = [dst];
  let cur = dst;
  while (cur !== src) { const [p, eid, rev] = pred.get(cur)!; edges.push([eid, rev]); nodes.push(p); cur = p; }
  return { cost: dist.get(dst)!, edges: edges.reverse(), nodes: nodes.reverse() };
}

/** Shared length divided by the shorter path's length. */
export function pathOverlap(g: { elen: ArrayLike<number> }, a: PathEdge[], b: PathEdge[]): number {
  const A = new Map(a.map(([e]) => [e, g.elen[e]])), B = new Map(b.map(([e]) => [e, g.elen[e]]));
  let shared = 0, la = 0, lb = 0;
  for (const [e, v] of A) { la += v; if (B.has(e)) shared += v; }
  for (const v of B.values()) lb += v;
  const shorter = Math.min(la, lb);
  if (shorter <= 1e-6) return !A.size && !B.size ? 1 : 0;
  return shared / shorter;
}

const sameRoot = (a: PathEdge[], b: PathEdge[], i: number) => { for (let k = 0; k < i; k++) if (a[k][0] !== b[k][0] || a[k][1] !== b[k][1]) return false; return true; };
/** Python tuple order for (cost, edges, nodes): cost, then edges [(eid, rev)...], then nodes. */
function lessPath(a: KPath, b: KPath): boolean {
  if (a.cost !== b.cost) return a.cost < b.cost;
  for (let k = 0; k < Math.min(a.edges.length, b.edges.length); k++) {
    if (a.edges[k][0] !== b.edges[k][0]) return a.edges[k][0] < b.edges[k][0];
    if (a.edges[k][1] !== b.edges[k][1]) return !a.edges[k][1];
  }
  if (a.edges.length !== b.edges.length) return a.edges.length < b.edges.length;
  for (let k = 0; k < Math.min(a.nodes.length, b.nodes.length); k++) if (a.nodes[k] !== b.nodes[k]) return a.nodes[k] < b.nodes[k];
  return a.nodes.length < b.nodes.length;
}

export interface YenOpts { maxK?: number; timeBudgetMs?: number; corridorM?: number; overlapMax?: number; costRatioMax?: number; diverseN?: number }

/** Yen's K-shortest loopless paths with a corridor limit and a diversity filter.
 *  Returns the diverse paths kept, every path found (A), and whether the time budget ran out. */
export function yenKShortest(g: RGraph, src: number, dst: number, cost: ArrayLike<number>, blocked: ArrayLike<number | boolean> | null, o: YenOpts = {}):
  { kept: KPath[]; all: KPath[]; hitBudget: boolean } {
  const maxK = o.maxK ?? 12, budget = o.timeBudgetMs ?? 1500, buf = o.corridorM ?? 1500;
  const overlapMax = o.overlapMax ?? 0.7, ratioMax = o.costRatioMax ?? 1.6, diverseN = o.diverseN ?? 4;
  const t0 = Date.now(), m = g.m;
  const base = new Uint8Array(m);
  if (blocked) for (let e = 0; e < m; e++) if (blocked[e]) base[e] = 1;
  let corridor = base.slice();
  const xs = g.nx[src], ys = g.ny[src], dx = g.nx[dst] - xs, dy = g.ny[dst] - ys, L2 = dx * dx + dy * dy;
  if (L2 > 1e-6) for (let e = 0; e < m; e++) {
    const t = Math.min(1, Math.max(0, ((g.emx[e] - xs) * dx + (g.emy[e] - ys) * dy) / L2));
    if (Math.hypot(g.emx[e] - (xs + t * dx), g.emy[e] - (ys + t * dy)) > buf) corridor[e] = 1;
  }
  let p0 = dijkstraSpur(g, src, dst, new Set(), corridor, cost);
  if (!p0) { corridor = base.slice(); p0 = dijkstraSpur(g, src, dst, new Set(), corridor, cost); if (!p0) return { kept: [], all: [], hitBudget: false }; }
  const A: KPath[] = [p0], kept: KPath[] = [p0], B: KPath[] = [], Bset = new Set<string>();
  const sig = (p: PathEdge[]) => p.map(([e]) => e).join(",");
  let hit = false, k = 1;
  const spur = corridor.slice();
  while (k < maxK && kept.length < diverseN) {
    if (Date.now() - t0 > budget) { hit = true; break; }
    const prev = A[k - 1];
    for (let i = 0; i < prev.edges.length; i++) {
      if (Date.now() - t0 > budget) { hit = true; break; }
      const spurNode = prev.nodes[i];
      const rootEdges = prev.edges.slice(0, i);
      const rootNodes = new Set(prev.nodes.slice(0, i));
      let rootCost = 0;
      for (const [e] of rootEdges) rootCost += cost[e];
      const restore: number[] = [];
      for (const p of A) {
        if (p.edges.length > i && sameRoot(p.edges, rootEdges, i)) {
          const eb = p.edges[i][0];
          if (!spur[eb]) { spur[eb] = 1; restore.push(eb); }
        }
      }
      const sp = dijkstraSpur(g, spurNode, dst, rootNodes, spur, cost);
      for (const e of restore) spur[e] = 0;
      if (sp) {
        const tot: KPath = { cost: rootCost + sp.cost, edges: [...rootEdges, ...sp.edges], nodes: [...prev.nodes.slice(0, i), ...sp.nodes] };
        const s = sig(tot.edges);
        if (!Bset.has(s) && A.every((p) => sig(p.edges) !== s)) { B.push(tot); Bset.add(s); }
      }
    }
    if (!B.length) break;
    let bi = 0;
    for (let j = 1; j < B.length; j++) if (lessPath(B[j], B[bi])) bi = j;
    const cheapest = B.splice(bi, 1)[0];
    A.push(cheapest);
    k++;
    if (cheapest.cost / Math.max(p0.cost, 1e-6) <= ratioMax && kept.every((kp) => pathOverlap(g, cheapest.edges, kp.edges) <= overlapMax)) kept.push(cheapest);
  }
  return { kept, all: A, hitBudget: hit };
}

// ---- comparing candidate ways (evaluate_candidate_routes) ----------------------------------------------
export interface CandidateMetrics {
  id: string; durationMin: { best: number | null; expected: number | null; worst: number | null };
  safety: { lo: number; hi: number }; outdoorMin: number; lightingDetail: string | null; havenDistM: number | null;
  feasibleWorst: boolean; worstEta: number | null;           // ms
  limitingStatus?: string;                                   // e.g. "PROBABLE" (technical "why" only)
}
/** Why a way won or lost, as a code the plain view turns into words (never numbers or engineer words). */
export type WhyCode = "recommended" | "late" | "dominated" | "faster_less_safe" | "less_safe" | "more_unlit" | "balance";
export interface ComparedWay {
  id: string; label: string; dominated: boolean; infeasibleWorst: boolean; score: number; recommended: boolean;
  slackMin: number; unknownShare: number; havenDistM: number; why: string; lossReason: string; whyCode: WhyCode;
  bits: { unlitFew: boolean; littleOutdoor: boolean; onTime: boolean };
}
export const COMPARE_WEIGHTS = { worst_safety: 0.4, deadline_slack: 0.25, outdoor_exposure: 0.15, unknown_share: 0.1, safe_haven_proximity: 0.1 };

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const pyRound = (v: number) => { const f = Math.floor(v), d = v - f; return d > 0.5 || (d === 0.5 && f % 2 !== 0) ? f + 1 : f; };   // Python round(): half to even
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** The `no data` share from a lighting detail: "40% no data" (the planner's wording) or "no data 40%".
 *  Deviation from the Python: it took the LAST word of the part, so "40% no data" gave "data", the
 *  number conversion failed silently and the share was always 0. Here the number is read either way. */
export function unknownShareOf(detail: string | null): number {
  if (!detail) return 0;
  for (const part of detail.split(",")) {
    if (!(part.includes("no data") || part.includes("no info"))) continue;
    const m = /(\d+(?:\.\d+)?)\s*%/.exec(part);
    if (m) return Number(m[1]) / 100;
  }
  return 0;
}

export function compareWays(plans: CandidateMetrics[], deadline: number | null, opt: { tieMargin?: number; tieOverlap?: number; weights?: typeof COMPARE_WEIGHTS } = {}):
  { ways: ComparedWay[]; tie: boolean; note: string | null; recommendedId: string | null } {
  if (!plans.length) return { ways: [], tie: false, note: null, recommendedId: null };
  const W = opt.weights ?? COMPARE_WEIGHTS, tieMargin = opt.tieMargin ?? 0.05, tieOverlap = opt.tieOverlap ?? 0.7;
  type R = ComparedWay & { m: { lo: number; hi: number; dw: number; de: number; out: number; unk: number; sh: number; slack: number } };
  const routes: R[] = plans.map((p, idx) => {
    const dw = p.durationMin.worst ?? 999, de = p.durationMin.expected ?? 999;
    const unk = unknownShareOf(p.lightingDetail);
    const sh = p.havenDistM ?? 500;
    const slack = deadline !== null && p.worstEta ? (deadline - p.worstEta) / 60000 : -de;
    return { id: p.id, label: `Way ${String.fromCharCode(65 + idx)}`, dominated: false, infeasibleWorst: deadline !== null ? !p.feasibleWorst : false,
      score: 0, recommended: false, slackMin: r1(slack), unknownShare: r2(unk), havenDistM: pyRound(sh), why: "", lossReason: "", whyCode: "balance",
      bits: { unlitFew: false, littleOutdoor: false, onTime: false },
      m: { lo: pyRound(p.safety.lo), hi: pyRound(p.safety.hi), dw, de, out: r1(p.outdoorMin), unk: r2(unk), sh: pyRound(sh), slack: r1(slack) } };
  });
  const hasFeasible = routes.some((r) => !r.infeasibleWorst);
  const eligible = hasFeasible ? routes.filter((r) => !r.infeasibleWorst) : [...routes];
  for (const r of routes) if (hasFeasible && r.infeasibleWorst) {
    r.lossReason = `Could miss your deadline before ${deadline !== null ? hhmm(deadline) : "arrival"} in the worst case.`;
    r.whyCode = "late";
  }
  for (const r of eligible) for (const o of eligible) {
    if (o === r) continue;
    const [sr, er, ur, so, eo, uo] = [r.m.lo, r.m.dw, r.m.unk, o.m.lo, o.m.dw, o.m.unk];
    if (so >= sr && eo <= er && uo <= ur && (so > sr || eo < er || uo < ur)) {
      r.dominated = true;
      r.lossReason = `Other choices offer higher safety (${so} vs ${sr}) with equal or better timing.`;
      r.whyCode = "dominated";
      break;
    }
  }
  const nonDom = eligible.filter((r) => !r.dominated);
  const pool = nonDom.length ? nonDom : eligible;
  const vals = (f: (r: R) => number) => pool.map(f);
  const [sv, slv, ov, uv, shv] = [vals((r) => r.m.lo), vals((r) => r.m.slack), vals((r) => r.m.out), vals((r) => r.m.unk), vals((r) => r.m.sh)];
  const nmax = (v: number, a: number[]) => { const mn = Math.min(...a), mx = Math.max(...a); return mx > mn ? (v - mn) / Math.max(mx - mn, 1e-4) : 1; };
  const nmin = (v: number, a: number[]) => { const mn = Math.min(...a), mx = Math.max(...a); return mx > mn ? (mx - v) / Math.max(mx - mn, 1e-4) : 1; };
  for (const r of pool) {
    r.score = r3(W.worst_safety * nmax(r.m.lo, sv) + W.deadline_slack * nmax(r.m.slack, slv) + W.outdoor_exposure * nmin(r.m.out, ov)
      + W.unknown_share * nmin(r.m.unk, uv) + W.safe_haven_proximity * nmin(r.m.sh, shv));
  }
  pool.sort((a, b) => b.score - a.score || b.m.lo - a.m.lo || a.m.de - b.m.de);
  let tie = false, note: string | null = null;
  if (pool.length >= 2) {
    const [t1, t2] = pool;
    const diff = Math.abs(t1.score - t2.score);
    const inter = Math.max(0, Math.min(t1.m.hi, t2.m.hi) - Math.max(t1.m.lo, t2.m.lo));
    const ov2 = inter / Math.min(Math.max(t1.m.hi - t1.m.lo, 1e-4), Math.max(t2.m.hi - t2.m.lo, 1e-4));
    if (diff <= tieMargin || ov2 > tieOverlap) {
      tie = true;
      if (t2.m.lo > t1.m.lo) [pool[0], pool[1]] = [pool[1], pool[0]];
      note = `Close choice: safety scores overlap by ${Math.trunc(ov2 * 100)}% and score gap is small (${diff.toFixed(2)}). `
        + `Picked ${pool[0].label} for higher safety score (${pool[0].m.lo}).`;
    }
  }
  const rec = pool[0];
  rec.recommended = true;
  rec.whyCode = "recommended";
  const st = rec.m;
  rec.bits = { unlitFew: st.unk <= 0.15, littleOutdoor: st.out <= 10, onTime: !rec.infeasibleWorst };
  rec.why = [`Safety score ${st.lo}–${st.hi} (${(plans.find((p) => p.id === rec.id)?.limitingStatus ?? "UNKNOWN").toLowerCase()} data)`, `takes about ${Math.trunc(st.de)} min`, ...(rec.bits.unlitFew ? ["avoids unlit streets"] : []),
    ...(rec.bits.littleOutdoor ? ["less time outdoors"] : []), ...(rec.bits.onTime ? ["arrives on time"] : [])].join("; ") + ".";
  for (const r of routes) {
    if (r === rec) continue;
    if (!r.lossReason) {
      const dt = r.m.de - st.de, ds = st.lo - r.m.lo;
      if (ds > 0 && dt < 0) { r.lossReason = `Takes ${Math.abs(Math.trunc(dt))} min less, but safety score is lower (${r.m.lo}–${r.m.hi} vs ${st.lo}–${st.hi}).`; r.whyCode = "faster_less_safe"; }
      else if (ds > 0) { r.lossReason = `Lower safety score (${r.m.lo}–${r.m.hi} vs ${st.lo}–${st.hi}).`; r.whyCode = "less_safe"; }
      else if (r.m.unk > st.unk) { r.lossReason = `Passes through ${Math.trunc(r.m.unk * 100)}% streets without lighting info.`; r.whyCode = "more_unlit"; }
      else { r.lossReason = "Scores lower on safety and outdoor exposure balance."; r.whyCode = "balance"; }
    }
    r.why = r.lossReason;
  }
  return { ways: routes.map(({ m: _m, ...w }) => { void _m; return w; }), tie, note, recommendedId: rec.id };
}

/** Diverse ways for the app: Yen's paths first (faithful port above); when a dense street grid makes
 *  Yen's next paths near-copies of the first (seen in Nagpur: 12 paths within 1% cost, 82-99% overlap,
 *  so the diversity filter keeps only one), the remaining slots are filled by the penalty method:
 *  streets already used cost more on each round, with the same diversity filter (overlap, cost ratio). */
export function diverseWays(g: RGraph, src: number, dst: number, cost: ArrayLike<number>, blocked: ArrayLike<number | boolean> | null, o: YenOpts & { penalty?: number; rounds?: number } = {}):
  { kept: KPath[]; fromYen: number; hitBudget: boolean } {
  const y = yenKShortest(g, src, dst, cost, blocked, o);
  const kept = [...y.kept];
  const want = o.diverseN ?? 4, overlapMax = o.overlapMax ?? 0.7, ratioMax = o.costRatioMax ?? 1.6;
  if (!kept.length || kept.length >= want) return { kept, fromYen: kept.length, hitBudget: y.hitBudget };
  const mask = new Uint8Array(g.m);
  if (blocked) for (let e = 0; e < g.m; e++) if (blocked[e]) mask[e] = 1;
  const pen = Float64Array.from(cost as ArrayLike<number>);
  const best = kept[0].cost;
  for (let r = 0; r < (o.rounds ?? 8) && kept.length < want; r++) {
    for (const p of kept) for (const [e] of p.edges) pen[e] *= o.penalty ?? 1.4;
    const p = dijkstraSpur(g, src, dst, new Set(), mask, pen);
    if (!p) break;
    let real = 0;
    for (const [e] of p.edges) real += cost[e];
    if (real / Math.max(best, 1e-6) > ratioMax) break;
    if (kept.every((k) => pathOverlap(g, p.edges, k.edges) <= overlapMax)) kept.push({ ...p, cost: real });
  }
  return { kept, fromYen: y.kept.length, hitBudget: y.hitBudget };
}

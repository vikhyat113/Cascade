"""Golden fixtures for the TypeScript port of the multi-route engine (UPGRADE §4).

Runs the ORIGINAL Python (`legacy/reference/routing_from_changes.py`, copied verbatim from the
`changes` branch) on a small seeded sample graph and writes what it returns, so
frontend/src/engine/__tests__/kshortest.test.ts can assert the TS port gives the same answers.

    backend/.venv/Scripts/python tools/golden_routing.py
"""
from __future__ import annotations

import json
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "legacy" / "reference" / "routing_from_changes.py"
OUT = ROOT / "frontend" / "src" / "engine" / "__tests__" / "fixtures" / "routing_golden.json"
COMPONENTS = ("lighting", "incident", "isolation", "traffic", "weather", "emergency")


def load_reference():
    """The verbatim module, with its two package imports replaced by stand-ins (nothing else changed)."""
    code = SRC.read_text(encoding="utf-8")
    code = code.replace("from .facts import STATUS_RANK", "STATUS_RANK = {'UNKNOWN': 0, 'OUTDATED': 1, 'PROBABLE': 2, 'KNOWN': 3}")
    code = code.replace("from .risk import COMPONENTS, EdgeRisk", f"COMPONENTS = {COMPONENTS!r}\nEdgeRisk = object")
    mod = types.ModuleType("routing_ref")
    exec(compile(code, str(SRC), "exec"), mod.__dict__)
    return mod


class SampleGraph:
    """7x7 grid (120 m) with some diagonals and jittered lengths: enough for real alternatives."""
    def __init__(self, rng):
        n, step = 7, 120.0
        xs, ys = [], []
        for j in range(n):
            for i in range(n):
                xs.append(i * step + rng.uniform(-15, 15)); ys.append(j * step + rng.uniform(-15, 15))
        self.x, self.y = np.array(xs), np.array(ys)
        U, V = [], []
        for j in range(n):
            for i in range(n):
                k = j * n + i
                if i + 1 < n: U.append(k); V.append(k + 1)
                if j + 1 < n: U.append(k); V.append(k + n)
                if i + 1 < n and j + 1 < n and rng.uniform() < 0.25: U.append(k); V.append(k + n + 1)
        self.u, self.v = np.array(U), np.array(V)
        self.m = len(U)
        self.elen = np.round(np.hypot(self.x[self.v] - self.x[self.u], self.y[self.v] - self.y[self.u]) * rng.uniform(1.0, 1.25, self.m), 1)
        self.emx, self.emy = (self.x[self.u] + self.x[self.v]) / 2, (self.y[self.u] + self.y[self.v]) / 2
        self._adj = [[] for _ in range(n * n)]
        for e in range(self.m):                       # undirected: both directions, rev flag like RoadGraph
            self._adj[self.u[e]].append((int(self.v[e]), e, False))
            self._adj[self.v[e]].append((int(self.u[e]), e, True))


def main():
    R = load_reference()
    rng = np.random.default_rng(7)
    G = SampleGraph(rng)
    lo = rng.uniform(0.0, 0.5, (6, G.m))
    hi = lo + rng.uniform(0.05, 0.5, (6, G.m))
    blocked = np.zeros(G.m, dtype=bool)
    blocked[[5, 40]] = True
    er = types.SimpleNamespace(lo=lo, hi=hi, blocked=blocked, weather=types.SimpleNamespace(walk_factor=(1.0, 0.95, 0.85)))
    weights = {"lighting": 0.24, "incident": 0.24, "isolation": 0.2, "traffic": 0.1, "weather": 0.1, "emergency": 0.12}
    speeds = {"best": 1.45, "expected": 1.25, "worst": 1.0}
    costs = {f"{lam}-{u}": R.compute_edge_cost(G, "walk", er, weights, speeds, lam=lam, u=u).tolist() for lam, u in ((0.0, 0.5), (1.0, 0.5), (2.0, 0.8))}
    cost = np.array(costs["1.0-0.5"])
    pairs = [(0, 48), (6, 42), (3, 45), (10, 38), (0, 0)]
    yen = []
    for s, d in pairs:
        kept, A, _, hit = R.yen_k_shortest_loopless_paths(G, s, d, cost, blocked_edges=blocked, K=8, max_K=12, time_budget_s=30.0,
                                                          corridor_buffer_m=300.0, overlap_max=0.7, cost_ratio_max=1.6, diverse_n=4)
        conv = lambda P: [{"cost": float(c), "edges": [[int(e), bool(r)] for e, r in E], "nodes": [int(x) for x in N]} for c, E, N in P]  # noqa: E731
        yen.append({"src": s, "dst": d, "kept": conv(kept), "all": conv(A), "hit_budget": bool(hit)})

    # route comparison on hand-made plans (one dominated, one infeasible, a close call at the top)
    t0 = datetime(2026, 10, 26, 2, 15, tzinfo=timezone.utc)
    deadline = t0 + timedelta(minutes=45)
    def plan(i, lo_, hi_, d_exp, d_worst, outdoor, nodata, haven=None, feasible=True):
        return {"id": f"p{i}", "kind": "walk", "title": f"Way {i}", "duration_min": {"best": d_exp - 5, "expected": d_exp, "worst": d_worst},
                "safety": {"lo": lo_, "hi": hi_}, "outdoor_min": outdoor,
                "trust": {"status": "PROBABLE", "limiting": "lighting",
                          "categories": [{"name": "lighting", "label": "Street lighting", "detail": f"5% mapped, 20% main roads, 30% satellite, no data {nodata}%"}]},   # the order the Python parser can read
                "safe_havens": [{"dist_m": haven}] if haven is not None else [],
                "eta": {"worst": (t0 + timedelta(minutes=d_worst)).isoformat()}, "feasible": {"worst": feasible, "expected": True, "best": True},
                "segments": [], "distance_m": 1000 + i}
    plans = [plan(0, 62, 78, 30, 38, 30, 40, 120), plan(1, 64, 80, 33, 41, 33, 20, None), plan(2, 55, 70, 35, 44, 35, 60, 300),
             plan(3, 70, 85, 50, 60, 50, 10, 80, feasible=False), plan(4, 63, 79, 31, 39, 31, 35, 150)]
    ctx = types.SimpleNamespace(req_deadline=deadline, t0=t0)
    routes, meta = R.evaluate_candidate_routes(ctx, plans, {})
    compare = {"routes": [{k: r[k] for k in ("id", "label", "dominated", "infeasible_worst", "score", "recommended", "why", "loss_reason")}
                          | {"slack_min": r["metrics"]["slack_min"], "unknown_lighting_share": r["metrics"]["unknown_lighting_share"],
                             "safe_haven_dist_m": r["metrics"]["safe_haven_dist_m"]} for r in routes],
               "meta": meta, "plans": plans, "deadline": deadline.isoformat(), "t0": t0.isoformat()}

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "_note": "generated by tools/golden_routing.py from legacy/reference/routing_from_changes.py (verbatim Python); do not edit",
        "graph": {"x": G.x.tolist(), "y": G.y.tolist(), "u": G.u.tolist(), "v": G.v.tolist(), "len": G.elen.tolist()},
        "er": {"lo": lo.tolist(), "hi": hi.tolist(), "blocked": [5, 40], "walk_factor": 0.95},
        "costs": costs, "yen": yen, "compare": compare}, indent=None), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {G.m} edges, {len(yen)} Yen queries, {len(routes)} compared routes, tie={meta['tie']}")
    for q in yen:
        print(f"  {q['src']}->{q['dst']}: kept {len(q['kept'])}, all {len(q['all'])}")


if __name__ == "__main__":
    main()

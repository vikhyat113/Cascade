"""Benchmark per-request routing time before (base Dijkstra) and after (Yen + diversity + evaluation)
on the real polygon graph for 3 representative origin-destination pairs.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app.config import get_config  # noqa: E402
from app.core.engine import Engine  # noqa: E402
from app.core.planner import Point, PlanRequest, Prefs, Ctx, plan_full  # noqa: E402
from app.core.routing import compute_edge_cost  # noqa: E402


def run_benchmark():
    cfg = get_config()
    engine = Engine(cfg=cfg, live=False, warmup=False)
    static = engine.static
    state = engine.state
    
    # 3 representative personas from config.yaml
    persona_ids = ["call_centre", "nurse", "security_guard"]
    
    print("=" * 96)
    print(f"{'Origin-Destination Pair':<32}{'Before (ms)':<14}{'After (ms)':<14}{'Diverse Routes':<16}{'Budget Hit?'}")
    print("=" * 96)
    
    budget_s = cfg.get("routing", {}).get("time_budget_s", 1.5)
    results = []
    
    for pid in persona_ids:
        per = next(p for p in static.personas if p["id"] == pid)
        o_pt = per["origin_point"]
        d_pt = per["home_point"]
        
        req = PlanRequest(
            origin=Point(lat=o_pt["lat"], lon=o_pt["lon"]),
            destination=Point(lat=d_pt["lat"], lon=d_pt["lon"]),
            start_time=per.get("finish_time", "02:00"),
            deadline=per.get("deadline", "03:00"),
            persona=pid,
            prefs=Prefs(
                risk_weight=per.get("risk_weight", 0.7),
                modes=per.get("modes", ["walk", "bus", "cab"]),
                max_walk_m=per.get("max_walk_m", 2500),
                lambda_val=cfg.get("routing", {}).get("lambda", 1.0),
                u=cfg.get("routing", {}).get("u", 0.5),
            ),
        )
        
        # Build planning context
        ctx = Ctx(state, req, engine.cache, state.now())
        G = static.walk
        o, _ = G.nearest_node(req.origin.lat, req.origin.lon)
        d, _ = G.nearest_node(req.destination.lat, req.destination.lon)
        er = ctx.er("walk", ctx.t0)
        
        rcfg = getattr(ctx, "routing_cfg", {})
        lam = ctx.req.prefs.lambda_val if getattr(ctx.req.prefs, "lambda_val", None) is not None else 1.0
        u = ctx.req.prefs.u if getattr(ctx.req.prefs, "u", None) is not None else 0.5
        k_exp = float(rcfg.get("k_exposure", 0.8))
        
        # 1. Measure "Before": single base Dijkstra on walk graph
        t0 = time.perf_counter()
        cost = compute_edge_cost(G, "walk", er, ctx.weights, ctx.speeds, lam, u, k_exp)
        _path = G.shortest_path(o, d, cost)
        t_before_ms = (time.perf_counter() - t0) * 1000.0
        
        # 2. Measure "After": full Yen's K-shortest paths + diversity filter + evaluation
        t1 = time.perf_counter()
        ps, _specs, _plans = plan_full(state, req, engine.cache)
        t_after_ms = (time.perf_counter() - t1) * 1000.0
        
        routes = ps.get("routes", [])
        num_routes = len(routes)
        budget_hit = (t_after_ms / 1000.0) >= budget_s
        
        pair_label = f"{per['label'][:30]}"
        print(f"{pair_label:<32}{t_before_ms:<14.2f}{t_after_ms:<14.2f}{num_routes:<16}{'YES' if budget_hit else 'No'}")
        
        results.append({
            "persona": pid,
            "label": per["label"],
            "t_before_ms": t_before_ms,
            "t_after_ms": t_after_ms,
            "num_routes": num_routes,
            "budget_hit": budget_hit,
            "tie": ps.get("route_tie", False),
            "tie_note": ps.get("route_tie_note", ""),
            "routes": routes,
        })
        
    print("=" * 96)
    print(f"Per-request Time Budget: {budget_s * 1000.0:.0f} ms")
    print(f"All requests completed well within budget: {all(not r['budget_hit'] for r in results)}")
    for r in results:
        print(f"\n--- {r['label']} Details ---")
        print(f"Before: {r['t_before_ms']:.2f} ms | After: {r['t_after_ms']:.2f} ms | Budget hit: {r['budget_hit']}")
        print(f"Diverse routes found: {r['num_routes']}")
        for rt in r["routes"]:
            rec_str = " [RECOMMENDED]" if rt.get("recommended") else ""
            dom_str = " [DOMINATED]" if rt.get("dominated") else ""
            print(f"  * {rt.get('label')} ({rt.get('id')}): {rt.get('why')}{rec_str}{dom_str}")
        if r.get("tie"):
            print(f"  Tie status: Close choice / tie detected: {r.get('tie_note')}")
        else:
            print("  Tie status: Clear winner")


if __name__ == "__main__":
    run_benchmark()

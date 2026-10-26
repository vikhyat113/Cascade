"""Tests for Multi-route engine: Yen's K-shortest-paths, diversity filter,
Pareto dominance, honest ties, and transparent evaluation.
"""
import heapq
import math
from datetime import datetime, timedelta, timezone

import networkx as nx
import numpy as np
import pytest

from app.core import planner
from app.core.routing import (
    compute_edge_cost,
    compute_safety_overlap,
    dijkstra_spur,
    evaluate_candidate_routes,
    path_overlap,
    yen_k_shortest_loopless_paths,
)


class MockRoadGraph:
    """Mock RoadGraph simulating MultiDiGraph with parallel edges, one-way roads, and loops."""
    def __init__(self, n, edges, directed=True):
        self.n = n
        self.directed = directed
        self.m = len(edges)
        self.eu = np.array([e[0] for e in edges], dtype=np.int64)
        self.ev = np.array([e[1] for e in edges], dtype=np.int64)
        self.elen = np.array([e[2] for e in edges], dtype=float)
        self.x = np.linspace(0, 1000, n)
        self.y = np.linspace(0, 1000, n)
        self.emx = (self.x[self.eu] + self.x[self.ev]) / 2.0
        self.emy = (self.y[self.eu] + self.y[self.ev]) / 2.0
        self.generated_at = "mock_v1"
        self._adj = self._build_adj()

    def _build_adj(self):
        adj = [[] for _ in range(self.n)]
        for eid in range(self.m):
            u, v = int(self.eu[eid]), int(self.ev[eid])
            adj[u].append((v, eid, False))
            if not self.directed:
                adj[v].append((u, eid, True))
        return adj


def test_yen_correctness_against_brute_force():
    """Verify Yen's algorithm against brute-force enumeration of simple paths
    in a MultiDiGraph with parallel edges and loops."""
    edges = [
        (0, 1, 2.0),  # e0
        (0, 1, 3.0),  # e1 (parallel edge)
        (1, 2, 2.0),  # e2
        (0, 2, 6.0),  # e3
        (1, 3, 5.0),  # e4
        (2, 3, 1.0),  # e5
        (2, 0, 4.0),  # e6 (back edge / loop)
    ]
    G_mock = MockRoadGraph(4, edges, directed=True)

    # Brute-force reference using NetworkX
    G_nx = nx.MultiDiGraph()
    for eid, (u, v, w) in enumerate(edges):
        G_nx.add_edge(u, v, key=eid, weight=w)

    brute_paths = []
    for p in nx.all_simple_edge_paths(G_nx, 0, 3):
        cost = sum(G_nx[u][v][k]["weight"] for u, v, k in p)
        edge_seq = [(k, False) for u, v, k in p]
        brute_paths.append((cost, edge_seq))
    brute_paths.sort(key=lambda x: (x[0], x[1]))

    # Yen's algorithm
    cost_arr = G_mock.elen.copy()
    kept, all_yen, dt, hit_budget = yen_k_shortest_loopless_paths(
        G_mock, 0, 3, cost_arr, blocked_edges=None,
        K=10, max_K=10, time_budget_s=5.0, corridor_buffer_m=1e6,
        overlap_max=1.0, cost_ratio_max=10.0, diverse_n=10
    )

    assert len(all_yen) == len(brute_paths), f"Expected {len(brute_paths)} simple paths, got {len(all_yen)}"
    for i in range(len(brute_paths)):
        assert math.isclose(all_yen[i][0], brute_paths[i][0], rel_tol=1e-5)
        # Check edge sequence
        yen_edges = all_yen[i][1]
        brute_edges = brute_paths[i][1]
        assert [e for e, _ in yen_edges] == [e for e, _ in brute_edges]


def test_diversity_filter_drops_near_duplicates():
    """Verify that paths with overlap > overlap_max or cost_ratio > cost_ratio_max are filtered."""
    edges = [
        (0, 1, 10.0),  # e0
        (1, 2, 10.0),  # e1
        (2, 3, 10.0),  # e2
        (0, 4, 10.0),  # e3
        (4, 2, 10.0),  # e4
        (1, 5, 2.0),   # e5 - tiny detour
        (5, 2, 8.5),   # e6 - tiny detour (almost identical to e1)
        (0, 6, 50.0),  # e7 - very expensive route
        (6, 3, 50.0),  # e8
    ]
    G_mock = MockRoadGraph(7, edges, directed=True)
    cost_arr = G_mock.elen.copy()

    # With overlap_max = 0.7: path through 5 is 28.5m / 30m = 95% overlapping, should be dropped
    kept, all_yen, _, _ = yen_k_shortest_loopless_paths(
        G_mock, 0, 3, cost_arr, blocked_edges=None,
        K=6, max_K=8, time_budget_s=2.0, corridor_buffer_m=1e6,
        overlap_max=0.7, cost_ratio_max=1.6, diverse_n=4
    )

    # The 2 diverse paths should be:
    # 1. 0 -> 1 -> 2 -> 3 (cost 30)
    # 2. 0 -> 4 -> 2 -> 3 (cost 30, overlap with 1 is 10/30 = 0.33 <= 0.7)
    # Detour through 5 has 20m shared out of 30m (overlap 0.67 or >0.7 depending on edges)
    # Route through 6 has cost 100 / 30 = 3.33 > 1.6, so it's dropped.
    assert len(kept) >= 2
    for i in range(len(kept)):
        for j in range(i + 1, len(kept)):
            ov = path_overlap(G_mock, kept[i][1], kept[j][1])
            assert ov <= 0.7, f"Overlap between kept paths {i} and {j} is {ov:.2f} > 0.7"
            ratio = kept[j][0] / kept[0][0]
            assert ratio <= 1.6, f"Cost ratio {ratio:.2f} > 1.6"


def test_pareto_dominance_and_feasibility_filter():
    """Verify Pareto dominance marking and hard worst-case feasibility filter."""
    now = datetime(2026, 10, 26, 2, 0, tzinfo=timezone(timedelta(hours=5, minutes=30)))
    deadline = now + timedelta(minutes=25)

    class MockCtx:
        req_deadline = deadline
        t0 = now

    mock_plans = [
        # Plan 0: Feasible, Safety 75, Duration 15m, UNKNOWN 0%
        {
            "id": "p0", "kind": "walk", "title": "Route 0", "walk_m": 1000,
            "feasible": {"best": True, "expected": True, "worst": True},
            "duration_min": {"best": 12.0, "expected": 15.0, "worst": 18.0},
            "eta": {"best": (now + timedelta(minutes=12)).isoformat(),
                    "expected": (now + timedelta(minutes=15)).isoformat(),
                    "worst": (now + timedelta(minutes=18)).isoformat()},
            "safety": {"lo": 75, "hi": 85}, "outdoor_min": 15.0,
            "trust": {"status": "KNOWN", "limiting": "lighting",
                      "categories": [{"name": "lighting", "label": "Street lighting", "status": "KNOWN", "detail": "90% mapped"}]},
            "safe_havens": [{"dist_m": 50}],
            "segments": [{"geometry": [[77.32, 28.57], [77.33, 28.58]]}]
        },
        # Plan 1: Dominated by Plan 0 (Safety 65 < 75, Duration 20m > 18m, UNKNOWN 10%)
        {
            "id": "p1", "kind": "walk", "title": "Route 1", "walk_m": 1200,
            "feasible": {"best": True, "expected": True, "worst": True},
            "duration_min": {"best": 16.0, "expected": 20.0, "worst": 24.0},
            "eta": {"best": (now + timedelta(minutes=16)).isoformat(),
                    "expected": (now + timedelta(minutes=20)).isoformat(),
                    "worst": (now + timedelta(minutes=24)).isoformat()},
            "safety": {"lo": 65, "hi": 78}, "outdoor_min": 20.0,
            "trust": {"status": "PROBABLE", "limiting": "lighting",
                      "categories": [{"name": "lighting", "label": "Street lighting", "status": "PROBABLE", "detail": "10% no data"}]},
            "safe_havens": [{"dist_m": 120}],
            "segments": [{"geometry": [[77.32, 28.57], [77.33, 28.58]]}]
        },
        # Plan 2: Infeasible in worst case (Duration worst 30m > 25m deadline)
        {
            "id": "p2", "kind": "walk", "title": "Route 2", "walk_m": 1800,
            "feasible": {"best": True, "expected": True, "worst": False},
            "duration_min": {"best": 18.0, "expected": 22.0, "worst": 30.0},
            "eta": {"best": (now + timedelta(minutes=18)).isoformat(),
                    "expected": (now + timedelta(minutes=22)).isoformat(),
                    "worst": (now + timedelta(minutes=30)).isoformat()},
            "safety": {"lo": 80, "hi": 90}, "outdoor_min": 22.0,
            "trust": {"status": "KNOWN", "limiting": "lighting",
                      "categories": [{"name": "lighting", "label": "Street lighting", "status": "KNOWN", "detail": "95% mapped"}]},
            "safe_havens": [],
            "segments": [{"geometry": [[77.32, 28.57], [77.33, 28.58]]}]
        },
    ]

    cfg = {
        "weights": {"worst_safety": 0.4, "deadline_slack": 0.25, "outdoor_exposure": 0.15, "unknown_share": 0.1, "safe_haven_proximity": 0.1},
        "tie_margin": 0.05,
        "tie_safety_overlap": 0.70
    }

    routes, tie_info = evaluate_candidate_routes(MockCtx(), mock_plans, cfg)
    r_by_id = {r["id"]: r for r in routes}

    # Plan 0 must be recommended
    assert r_by_id["p0"]["recommended"] is True
    assert r_by_id["p0"]["dominated"] is False

    # Plan 1 must be marked dominated
    assert r_by_id["p1"]["dominated"] is True
    assert "dominated" in r_by_id["p1"]["loss_reason"].lower() or "higher safety" in r_by_id["p1"]["loss_reason"].lower()

    # Plan 2 must be marked worst-case infeasible
    assert r_by_id["p2"]["infeasible_worst"] is True
    assert "deadline" in r_by_id["p2"]["loss_reason"].lower()


def test_tie_handling_flags_no_clear_winner():
    """Verify that when safety intervals overlap > 70% and scores are within tie_margin,
    a tie is flagged and higher worst-case safety is recommended."""
    now = datetime(2026, 10, 26, 2, 0, tzinfo=timezone(timedelta(hours=5, minutes=30)))

    class MockCtx:
        req_deadline = None
        t0 = now

    mock_plans = [
        {
            "id": "pA", "kind": "walk", "title": "Route A", "walk_m": 1000,
            "feasible": {"best": True, "expected": True, "worst": True},
            "duration_min": {"best": 14.0, "expected": 15.0, "worst": 17.0},
            "eta": {"best": (now + timedelta(minutes=14)).isoformat(),
                    "expected": (now + timedelta(minutes=15)).isoformat(),
                    "worst": (now + timedelta(minutes=17)).isoformat()},
            "safety": {"lo": 70, "hi": 82}, "outdoor_min": 15.0,
            "trust": {"status": "KNOWN", "limiting": "lighting",
                      "categories": [{"name": "lighting", "label": "Street lighting", "status": "KNOWN", "detail": "90% mapped"}]},
            "safe_havens": [{"dist_m": 60}],
            "segments": [{"geometry": [[77.32, 28.57], [77.33, 28.58]]}]
        },
        {
            "id": "pB", "kind": "walk", "title": "Route B", "walk_m": 950,
            "feasible": {"best": True, "expected": True, "worst": True},
            "duration_min": {"best": 13.0, "expected": 14.0, "worst": 16.0},
            "eta": {"best": (now + timedelta(minutes=13)).isoformat(),
                    "expected": (now + timedelta(minutes=14)).isoformat(),
                    "worst": (now + timedelta(minutes=16)).isoformat()},
            "safety": {"lo": 69, "hi": 81}, "outdoor_min": 14.0,
            "trust": {"status": "KNOWN", "limiting": "lighting",
                      "categories": [{"name": "lighting", "label": "Street lighting", "status": "KNOWN", "detail": "88% mapped"}]},
            "safe_havens": [{"dist_m": 65}],
            "segments": [{"geometry": [[77.32, 28.57], [77.33, 28.58]]}]
        },
    ]

    cfg = {
        "weights": {"worst_safety": 0.4, "deadline_slack": 0.25, "outdoor_exposure": 0.15, "unknown_share": 0.1, "safe_haven_proximity": 0.1},
        "tie_margin": 0.05,
        "tie_safety_overlap": 0.70
    }

    routes, tie_info = evaluate_candidate_routes(MockCtx(), mock_plans, cfg)
    assert tie_info["tie"] is True
    assert "close choice" in tie_info["note"].lower() or "overlap" in tie_info["note"].lower()
    # Recommended one has higher worst-case safety (70 >= 69)
    assert routes[0]["metrics"]["safety"]["lo"] >= routes[1]["metrics"]["safety"]["lo"]
    assert routes[0]["recommended"] is True


def test_api_get_plan_routes(engine, corners):
    """Verify GET /api/plan/{pid}/routes returns diverse routes with metrics and score breakdown."""
    from starlette.testclient import TestClient
    from app.main import app
    import app.api.routes as routes

    routes.ENGINE["engine"] = engine
    client = TestClient(app)
    sw, ne = corners
    req_payload = {
        "origin": {"lat": sw["lat"], "lon": sw["lon"], "name": sw["name"]},
        "destination": {"lat": ne["lat"], "lon": ne["lon"], "name": ne["name"]},
        "prefs": {"risk_weight": 0.7, "modes": ["walk", "cab"]}
    }
    resp = client.post("/api/plan", json=req_payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    plan_id = data.get("details", {}).get("id") or data.get("id")

    # Get routes
    routes_resp = client.get(f"/api/plan/{plan_id}/routes")
    assert routes_resp.status_code == 200, routes_resp.text
    rdata = routes_resp.json()
    assert "routes" in rdata
    assert len(rdata["routes"]) >= 1
    first = rdata["routes"][0]
    assert "metrics" in first
    assert "score_breakdown" in first
    assert "why" in first
    assert "polyline" in first
    assert any(r["recommended"] for r in rdata["routes"])

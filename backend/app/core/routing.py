"""Multi-route engine: Yen's K-shortest-loopless-paths with safety-aware cost,
diversity filter, and transparent multi-attribute evaluation.

Rules:
- Base search uses Dijkstra.
- Yen's algorithm generates alternative loopless paths.
- Corridor restriction keeps spur path searches fast on the polygon graph.
- MultiDiGraph parallel edges and one-way roads are handled correctly.
- Near-duplicates are filtered via overlap threshold and cost ratio.
- Evaluation computes worst-case safety, worst-case ETA, UNKNOWN lighting share,
  outdoor exposure, and safe haven proximity.
- Hard feasibility filter drops worst-case infeasible routes if any feasible exists.
- Pareto dominance check marks dominated routes.
- Preference score with honest tie detection (tie_margin <= 0.05 or >70% safety overlap).
- Plain-language explanations without banned words.
"""
from __future__ import annotations

import heapq
import math
import time
from datetime import datetime, timedelta
from typing import Optional

import numpy as np

from .facts import STATUS_RANK
from .risk import COMPONENTS, EdgeRisk


BLOCKED_COST = 1e12


def compute_edge_cost(G, which: str, er: EdgeRisk, weights: dict,
                      speeds: dict, lam: float = 1.0, u: float = 0.5,
                      k_exposure: float = 0.8) -> np.ndarray:
    """Calculate safety-aware edge costs:
    edge_cost = time_s + lambda * risk_effective * length_m * k_exposure
    where risk_effective = (1 - u) * mid + u * hi.
    """
    tot = sum(weights.values()) or 1.0
    w = np.array([weights[c] for c in COMPONENTS], dtype=float)[:, None] / tot
    mid_comp = er.lo + 0.6 * (er.hi - er.lo)
    mid = (w * mid_comp).sum(axis=0)
    hi = (w * er.hi).sum(axis=0)
    risk_effective = (1.0 - u) * mid + u * hi

    if which == "walk":
        wf = er.weather.walk_factor[1] if hasattr(er, "weather") and er.weather else 1.0
        base_speed = max(speeds.get("expected", 1.25) * wf, 0.2)
        time_s = G.elen / base_speed
    else:
        # Cab / drive
        if getattr(er, "drive", None) is not None:
            time_s = er.drive.exp
        else:
            time_s = G.elen / 10.0

    cost = time_s + lam * risk_effective * G.elen * k_exposure
    if er.blocked is not None and er.blocked.any():
        cost = np.where(er.blocked, BLOCKED_COST, cost)
    return np.maximum(cost, 0.01).astype(float)


def dijkstra_spur(G, src: int, dst: int, blocked_nodes: set[int],
                  blocked_edges_mask: np.ndarray, cost_arr: np.ndarray):
    """Priority queue Dijkstra for a single pair (spur path).
    Returns (cost, edges_list, nodes_list) or (None, None, None).
    """
    if src in blocked_nodes or dst in blocked_nodes:
        return None, None, None
    if src == dst:
        return 0.0, [], [src]

    dist = {src: 0.0}
    pred = {}
    pq = [(0.0, src)]

    adj = G._adj
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, float("inf")):
            continue
        if u == dst:
            break
        for v, eid, rev in adj[u]:
            if v in blocked_nodes or blocked_edges_mask[eid]:
                continue
            c = cost_arr[eid]
            nd = d + c
            if nd < dist.get(v, float("inf")):
                dist[v] = nd
                pred[v] = (u, eid, rev, c)
                heapq.heappush(pq, (nd, v))

    if dst not in dist:
        return None, None, None

    curr = dst
    path_edges = []
    path_nodes = [dst]
    while curr != src:
        p, eid, rev, c = pred[curr]
        path_edges.append((eid, rev))
        path_nodes.append(p)
        curr = p
    path_edges.reverse()
    path_nodes.reverse()
    return dist[dst], path_edges, path_nodes


def path_length_m(G, edges: list[tuple[int, bool]]) -> float:
    return sum(float(G.elen[eid]) for eid, _ in edges)


def path_overlap(G, edges_a: list[tuple[int, bool]], edges_b: list[tuple[int, bool]]) -> float:
    """Shared length divided by shorter path length."""
    set_a = {eid: float(G.elen[eid]) for eid, _ in edges_a}
    set_b = {eid: float(G.elen[eid]) for eid, _ in edges_b}
    shared = sum(v for eid, v in set_a.items() if eid in set_b)
    len_a = sum(set_a.values())
    len_b = sum(set_b.values())
    shorter = min(len_a, len_b)
    if shorter <= 1e-6:
        return 1.0 if not set_a and not set_b else 0.0
    return shared / shorter


def yen_k_shortest_loopless_paths(G, src: int, dst: int, cost_arr: np.ndarray,
                                  blocked_edges: Optional[np.ndarray] = None,
                                  K: int = 8, max_K: int = 12, time_budget_s: float = 1.5,
                                  corridor_buffer_m: float = 1500.0, overlap_max: float = 0.7,
                                  cost_ratio_max: float = 1.6, diverse_n: int = 4):
    """Yen's K-shortest loopless paths algorithm with diversity filter and corridor restriction.
    Returns: (kept_paths, all_paths, time_taken_s, hit_budget)
    Each path is (cost, edges, nodes).
    """
    t0 = time.perf_counter()
    m = G.m
    base_mask = np.zeros(m, dtype=bool)
    if blocked_edges is not None and blocked_edges.any():
        base_mask |= blocked_edges

    # Spatial corridor restriction
    xs, ys = G.x[src], G.y[src]
    xd, yd = G.x[dst], G.y[dst]
    dx, dy = xd - xs, yd - ys
    L2 = dx * dx + dy * dy
    if L2 > 1e-6:
        t = np.clip(((G.emx - xs) * dx + (G.emy - ys) * dy) / L2, 0.0, 1.0)
        px = xs + t * dx
        py = ys + t * dy
        dist_to_line = np.hypot(G.emx - px, G.emy - py)
        corridor_mask = base_mask | (dist_to_line > corridor_buffer_m)
    else:
        corridor_mask = base_mask.copy()

    # Base path
    d0, e0, n0 = dijkstra_spur(G, src, dst, set(), corridor_mask, cost_arr)
    if e0 is None:
        # Fallback without corridor restriction if no path found
        corridor_mask = base_mask.copy()
        d0, e0, n0 = dijkstra_spur(G, src, dst, set(), corridor_mask, cost_arr)
        if e0 is None:
            return [], [], time.perf_counter() - t0, False

    A = [(d0, e0, n0)]
    kept = [(d0, e0, n0)]
    B = []
    B_set = set()
    hit_budget = False

    k = 1
    spur_mask = corridor_mask.copy()

    while k < max_K and len(kept) < diverse_n:
        if time.perf_counter() - t0 > time_budget_s:
            hit_budget = True
            break

        prev_cost, prev_edges, prev_nodes = A[k - 1]
        for i in range(len(prev_edges)):
            if time.perf_counter() - t0 > time_budget_s:
                hit_budget = True
                break

            spur_node = prev_nodes[i]
            root_edges = prev_edges[:i]
            root_nodes = set(prev_nodes[:i])
            root_cost = sum(cost_arr[eid] for eid, _ in root_edges)

            # Block edges in A that share root_edges prefix
            edges_to_restore = []
            for (p_cost, p_edges, p_nodes) in A:
                if len(p_edges) > i and p_edges[:i] == root_edges:
                    e_branch = p_edges[i][0]
                    if not spur_mask[e_branch]:
                        spur_mask[e_branch] = True
                        edges_to_restore.append(e_branch)

            spur_cost, spur_edges, spur_nodes = dijkstra_spur(G, spur_node, dst, root_nodes, spur_mask, cost_arr)

            # Restore blocked edges
            for eid in edges_to_restore:
                spur_mask[eid] = False

            if spur_edges is not None:
                tot_edges = root_edges + spur_edges
                tot_nodes = prev_nodes[:i] + spur_nodes
                tot_cost = root_cost + spur_cost
                sig = tuple(eid for eid, _ in tot_edges)
                if sig not in B_set and all(tuple(eid for eid, _ in p[1]) != sig for p in A):
                    heapq.heappush(B, (tot_cost, tot_edges, tot_nodes))
                    B_set.add(sig)

        if not B:
            break

        cheapest = heapq.heappop(B)
        A.append(cheapest)
        k += 1

        # Diversity check
        cost_ratio = cheapest[0] / max(d0, 1e-6)
        if cost_ratio <= cost_ratio_max:
            overlaps = [path_overlap(G, cheapest[1], kp[1]) for kp in kept]
            if all(ov <= overlap_max for ov in overlaps):
                kept.append(cheapest)

    dt = time.perf_counter() - t0
    return kept, A, dt, hit_budget


def compute_safety_overlap(interval_a: tuple[float, float], interval_b: tuple[float, float]) -> float:
    """Compute overlap percentage between two safety intervals [lo, hi]."""
    lo_a, hi_a = interval_a
    lo_b, hi_b = interval_b
    inter = max(0.0, min(hi_a, hi_b) - max(lo_a, lo_b))
    span_a = max(hi_a - lo_a, 1e-4)
    span_b = max(hi_b - lo_b, 1e-4)
    shorter = min(span_a, span_b)
    return inter / shorter


def evaluate_candidate_routes(ctx, evaluated_plans: list[dict], routing_cfg: dict) -> tuple[list[dict], dict]:
    """Transparent multi-attribute evaluation for kept diverse routes.
    Implements:
    - Hard feasibility filter
    - Pareto dominance check (worst_case_safety, worst_case_ETA, UNKNOWN share)
    - Preference scoring (weighted sum normalized across candidates)
    - Honest tie detection (tie_margin <= 0.05 or >70% safety overlap)
    - Plain-language explanations without banned words.
    """
    if not evaluated_plans:
        return [], {"tie": False, "note": None}

    weights_cfg = routing_cfg.get("weights", {
        "worst_safety": 0.4,
        "deadline_slack": 0.25,
        "outdoor_exposure": 0.15,
        "unknown_share": 0.1,
        "safe_haven_proximity": 0.1,
    })
    tie_margin = float(routing_cfg.get("tie_margin", 0.05))
    tie_overlap_max = float(routing_cfg.get("tie_safety_overlap", 0.70))

    deadline = ctx.req_deadline
    now = ctx.t0

    routes = []
    for idx, p in enumerate(evaluated_plans):
        # Extract metrics
        dur_w = p["duration_min"]["worst"] if p["duration_min"]["worst"] is not None else 999.0
        dur_e = p["duration_min"]["expected"] if p["duration_min"]["expected"] is not None else 999.0
        dur_b = p["duration_min"]["best"] if p["duration_min"]["best"] is not None else 999.0
        safety_lo = float(p["safety"]["lo"])
        safety_hi = float(p["safety"]["hi"])
        outdoor_m = float(p.get("outdoor_min", 0.0))

        # UNKNOWN lighting share
        light_cat = next((c for c in p["trust"]["categories"] if c["name"] == "lighting"), None)
        unk_share = 0.0
        if light_cat and "detail" in light_cat:
            detail = light_cat["detail"]
            if "no data" in detail or "no info" in detail:
                try:
                    for part in detail.split(","):
                        if "no data" in part or "no info" in part:
                            num = part.replace("%", "").strip().split()[-1]
                            unk_share = float(num) / 100.0
                except Exception:
                    pass

        # Safe haven distance along path
        havens = p.get("safe_havens", [])
        if havens:
            sh_dist = min(float(h.get("dist_m", 500.0)) for h in havens)
        else:
            sh_dist = 500.0

        # Deadline slack (minutes)
        if deadline is not None and p["eta"]["worst"]:
            worst_arr = datetime.fromisoformat(p["eta"]["worst"])
            slack_min = (deadline - worst_arr).total_seconds() / 60.0
        else:
            slack_min = -dur_e

        # Geometry coordinates: Leaflet expects [lat, lon]
        all_coords = []
        for seg in p.get("segments", []):
            for c in seg.get("geometry", []):
                # c is [lon, lat] from GeoJSON
                all_coords.append([c[1], c[0]])

        # Weakest link status & limiting category
        lim_name = p["trust"].get("limiting")
        lim_st = p["trust"].get("status", "UNKNOWN")
        lim_cat = next((c for c in p["trust"]["categories"] if c["name"] == lim_name), None)
        lim_label = lim_cat["label"] if lim_cat else "Overall data"

        label_letter = chr(ord("A") + idx)
        routes.append({
            "id": p["id"],
            "index": idx,
            "label": f"Way {label_letter}",
            "kind": p["kind"],
            "title": p.get("title", f"Way {label_letter}"),
            "polyline": all_coords,
            "metrics": {
                "eta": p["eta"],
                "duration_min": {"best": dur_b, "expected": dur_e, "worst": dur_w},
                "safety": {"lo": int(round(safety_lo)), "hi": int(round(safety_hi))},
                "safety_status": lim_st,
                "outdoor_min": round(outdoor_m, 1),
                "unknown_lighting_share": round(unk_share, 2),
                "safe_haven_dist_m": round(sh_dist),
                "distance_m": p.get("distance_m", 0),
                "feasible": p["feasible"],
                "slack_min": round(slack_min, 1),
                "limiting_label": lim_label,
                "limiting_status": lim_st,
            },
            "dominated": False,
            "infeasible_worst": not p["feasible"]["worst"] if deadline is not None else False,
            "score": 0.0,
            "score_breakdown": {},
            "why": "",
            "loss_reason": "",
            "recommended": False,
            "plan_ref": p,
        })

    # a. Hard filter: drop routes infeasible in worst case if any feasible exists
    has_feasible = any(not r["infeasible_worst"] for r in routes)
    eligible_pool = [r for r in routes if not r["infeasible_worst"]] if has_feasible else list(routes)
    infeasible_pool = [r for r in routes if r["infeasible_worst"]] if has_feasible else []

    for r in infeasible_pool:
        r["loss_reason"] = f"Could miss your deadline before {deadline.strftime('%H:%M') if deadline else 'arrival'} in the worst case."

    # b. Pareto check on (worst-case safety, -worst-case ETA, -UNKNOWN share)
    for r in eligible_pool:
        s_r = r["metrics"]["safety"]["lo"]
        e_r = r["metrics"]["duration_min"]["worst"]
        u_r = r["metrics"]["unknown_lighting_share"]
        for o in eligible_pool:
            if o is r:
                continue
            s_o = o["metrics"]["safety"]["lo"]
            e_o = o["metrics"]["duration_min"]["worst"]
            u_o = o["metrics"]["unknown_lighting_share"]
            # Dominates if >= in all three and > in at least one
            if s_o >= s_r and e_o <= e_r and u_o <= u_r and (s_o > s_r or e_o < e_r or u_o < u_r):
                r["dominated"] = True
                r["loss_reason"] = f"Other choices offer higher safety ({s_o} vs {s_r}) with equal or better timing."
                break

    non_dominated = [r for r in eligible_pool if not r["dominated"]]
    ranking_pool = non_dominated if non_dominated else eligible_pool

    # c. Preference score calculation among non-dominated candidates
    s_vals = [r["metrics"]["safety"]["lo"] for r in ranking_pool]
    slack_vals = [r["metrics"]["slack_min"] for r in ranking_pool]
    out_vals = [r["metrics"]["outdoor_min"] for r in ranking_pool]
    u_vals = [r["metrics"]["unknown_lighting_share"] for r in ranking_pool]
    sh_vals = [r["metrics"]["safe_haven_dist_m"] for r in ranking_pool]

    def norm_max(v, vals):
        mn, mx = min(vals), max(vals)
        return (v - mn) / max(mx - mn, 1e-4) if mx > mn else 1.0

    def norm_min(v, vals):
        mn, mx = min(vals), max(vals)
        return (mx - v) / max(mx - mn, 1e-4) if mx > mn else 1.0

    for r in ranking_pool:
        m = r["metrics"]
        n_safe = norm_max(m["safety"]["lo"], s_vals)
        n_slack = norm_max(m["slack_min"], slack_vals)
        n_outdoor = norm_min(m["outdoor_min"], out_vals)
        n_unk = norm_min(m["unknown_lighting_share"], u_vals)
        n_sh = norm_min(m["safe_haven_dist_m"], sh_vals)

        score = (
            weights_cfg["worst_safety"] * n_safe
            + weights_cfg["deadline_slack"] * n_slack
            + weights_cfg["outdoor_exposure"] * n_outdoor
            + weights_cfg["unknown_share"] * n_unk
            + weights_cfg["safe_haven_proximity"] * n_sh
        )
        r["score"] = round(score, 3)
        r["score_breakdown"] = {
            "safety_score": round(weights_cfg["worst_safety"] * n_safe, 3),
            "timing_score": round(weights_cfg["deadline_slack"] * n_slack, 3),
            "indoor_score": round(weights_cfg["outdoor_exposure"] * n_outdoor, 3),
            "lighting_score": round(weights_cfg["unknown_share"] * n_unk, 3),
            "help_proximity_score": round(weights_cfg["safe_haven_proximity"] * n_sh, 3),
            "total": round(score, 3),
        }

    ranking_pool.sort(key=lambda r: (-r["score"], -r["metrics"]["safety"]["lo"], r["metrics"]["duration_min"]["expected"]))

    # d. Honest tie detection
    tie_flag = False
    tie_note = None
    if len(ranking_pool) >= 2:
        top1 = ranking_pool[0]
        top2 = ranking_pool[1]
        score_diff = abs(top1["score"] - top2["score"])
        int1 = (top1["metrics"]["safety"]["lo"], top1["metrics"]["safety"]["hi"])
        int2 = (top2["metrics"]["safety"]["lo"], top2["metrics"]["safety"]["hi"])
        s_overlap = compute_safety_overlap(int1, int2)

        if score_diff <= tie_margin or s_overlap > tie_overlap_max:
            tie_flag = True
            # Recommend the one with higher worst-case safety
            if top2["metrics"]["safety"]["lo"] > top1["metrics"]["safety"]["lo"]:
                ranking_pool[0], ranking_pool[1] = ranking_pool[1], ranking_pool[0]
                top1, top2 = top2, top1
            tie_note = (
                f"Close choice: safety scores overlap by {int(s_overlap * 100)}% and score gap is small ({score_diff:.2f}). "
                f"Picked {ranking_pool[0]['label']} for higher safety score ({ranking_pool[0]['metrics']['safety']['lo']})."
            )

    rec = ranking_pool[0]
    rec["recommended"] = True

    # Generate plain-language 'why' and 'loss_reason'
    s_lo = rec["metrics"]["safety"]["lo"]
    s_hi = rec["metrics"]["safety"]["hi"]
    lim_st = rec["metrics"]["safety_status"]
    dur = rec["metrics"]["duration_min"]["expected"]
    why_bits = [f"Safety score {s_lo}–{s_hi} ({lim_st.lower()} data)", f"takes about {int(dur)} min"]
    if rec["metrics"]["unknown_lighting_share"] <= 0.15:
        why_bits.append("avoids unlit streets")
    if rec["metrics"]["outdoor_min"] <= 10.0:
        why_bits.append("less time outdoors")
    if not rec["infeasible_worst"]:
        why_bits.append("arrives on time")
    rec["why"] = "; ".join(why_bits) + "."

    for r in routes:
        if r is rec:
            continue
        if not r["loss_reason"]:
            diff_time = r["metrics"]["duration_min"]["expected"] - rec["metrics"]["duration_min"]["expected"]
            diff_safety = rec["metrics"]["safety"]["lo"] - r["metrics"]["safety"]["lo"]
            if diff_safety > 0 and diff_time < 0:
                r["loss_reason"] = f"Takes {abs(int(diff_time))} min less, but safety score is lower ({r['metrics']['safety']['lo']}–{r['metrics']['safety']['hi']} vs {s_lo}–{s_hi})."
            elif diff_safety > 0:
                r["loss_reason"] = f"Lower safety score ({r['metrics']['safety']['lo']}–{r['metrics']['safety']['hi']} vs {s_lo}–{s_hi})."
            elif r["metrics"]["unknown_lighting_share"] > rec["metrics"]["unknown_lighting_share"]:
                pct = int(r["metrics"]["unknown_lighting_share"] * 100)
                r["loss_reason"] = f"Passes through {pct}% streets without lighting info."
            else:
                r["loss_reason"] = f"Scores lower on safety and outdoor exposure balance."
        r["why"] = r["loss_reason"]

    return routes, {"tie": tie_flag, "note": tie_note}

"""Need-now finder: "I need medicine / food / ATM / hospital now".

Returns the nearest places that are open *when you would arrive*, reached by a
safety-weighted walking route, ranked by how sure we are they are open:
KNOWN-open > PROBABLE-open > UNKNOWN hours (shown, never claimed open) > closed.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

import numpy as np

from .planner import mkview
from .risk import combine, edge_cost_risk, edge_risk, path_components
from .services import open_fact

NEEDS = {
    "pharmacy": ["pharmacy"], "medicine": ["pharmacy", "hospital"], "hospital": ["hospital"],
    "police": ["police"], "food": ["food", "shop"], "atm": ["atm"], "fuel": ["fuel"],
    "toilets": ["toilets"], "shop": ["shop"],
}
# Tier 0: confirmed or probably open (ranked together by walking time, PROBABLE slightly penalised);
# tier 1: hours UNKNOWN or open-state OUTDATED (listed, never claimed open); anything else last.
OPEN_TIER = {("KNOWN", True): (0, 1.0), ("PROBABLE", True): (0, 1.2), ("UNKNOWN", None): (1, 1.0),
             ("OUTDATED", True): (1, 1.2)}


def need_now(engine, kind: str, lat: float, lon: float, t: Optional[datetime] = None, limit: int = 3) -> dict:
    s, st = engine.state, engine.static
    cats = NEEDS.get(kind)
    if cats is None:
        raise ValueError(f"unknown need '{kind}'. Try one of: {', '.join(NEEDS)}")
    t = t or s.now()
    x, y = st.proj.xy(lat, lon)
    cands = sorted((p for p in st.facilities if p.cat in cats), key=lambda p: (p.x - x) ** 2 + (p.y - y) ** 2)
    cands = [p for p in cands if np.hypot(p.x - x, p.y - y) < 4000][:10]
    G = st.walk
    er = edge_risk(s, "walk", t, engine.cache)
    weights = st.risk_cfg["weights"]
    cost = G.elen / 1.25 + 2.0 * st.planner_cfg["risk_cost_s_per_m"] * G.elen * edge_cost_risk(er, weights)
    o, od = G.nearest_node(lat, lon)
    sp = st.planner_cfg["walk_speed_mps"]
    wf = er.weather.walk_factor
    results, closed = [], []
    for p in cands:
        d, dd = G.nearest_node(p.lat, p.lon)
        path = G.shortest_path(o, d, cost, er.blocked)
        if path is None:
            continue
        idx = np.array([e for e, _ in path], dtype=int)
        dist = float(G.elen[idx].sum()) + od + dd if len(idx) else od + dd
        eta = [dist / (sp["best"] * wf[0]), dist / (sp["expected"] * wf[1]), dist / (sp["worst"] * wf[2])]
        arrive = t + timedelta(seconds=eta[1])
        f = open_fact(s, p, arrive)
        v = s.view(f)
        comps = path_components(er, idx, G.elen) if len(idx) else None
        lo, hi = combine(comps, weights) if comps else (0.0, 0.0)
        item = {
            "id": p.id, "name": p.label, "cat": p.cat, "lat": p.lat, "lon": p.lon, "open": v.model_dump(),
            "distance_m": round(dist),
            "eta": {c: (t + timedelta(seconds=e)).isoformat(timespec="seconds") for c, e in
                    zip(("best", "expected", "worst"), eta)},
            "minutes": {"best": round(eta[0] / 60, 1), "expected": round(eta[1] / 60, 1), "worst": round(eta[2] / 60, 1)},
            "safety": {"lo": round(100 * (1 - hi)), "hi": round(100 * (1 - lo))},
            "geometry": [[lon, lat]] + G.path_coords(path) + [[p.lon, p.lat]],
            "explanation": _explain(v), "confidence_open": v.confidence if v.value is True else 0.0,
        }
        if v.value is False and v.status in ("KNOWN", "PROBABLE"):
            closed.append(item)
            continue
        tier, mult = OPEN_TIER.get((v.status, v.value), (2, 1.0))
        item["_rank"] = (tier, eta[1] * mult)
        results.append(item)
    results.sort(key=lambda r: r["_rank"])
    deduped = []
    for r in results:                     # OSM often maps one place twice (node + building)
        if any(r["name"] == d["name"] and abs(r["lat"] - d["lat"]) < 0.0015 and abs(r["lon"] - d["lon"]) < 0.0015
               for d in deduped):
            continue
        r.pop("_rank")
        deduped.append(r)
    results = deduped
    out = {"kind": kind, "time": t.isoformat(timespec="seconds"), "results": results[:limit],
           "closed_nearby": closed[:3], "weather": er.weather.view.model_dump()}
    if results and results[0]["open"]["status"] not in ("KNOWN", "PROBABLE"):
        out["note"] = ("No nearby option is confirmed open. Places marked UNKNOWN have no listed hours: "
                       "call ahead before walking there.")
        if kind in ("pharmacy", "medicine"):
            hosp = need_now(engine, "hospital", lat, lon, t, limit=1)["results"]
            if hosp and hosp[0]["open"]["status"] in ("KNOWN", "PROBABLE"):
                h = hosp[0]
                h["explanation"] += " Hospitals usually run a 24h pharmacy (inferred)."
                out["fallback"] = h
    if not results:
        out["note"] = f"No reachable {kind} found within 4 km."
    return out


def _explain(v) -> str:
    if v.status == "KNOWN":
        return f"{'Open' if v.value else 'Closed'} at arrival: {v.note}."
    if v.status == "PROBABLE":
        return f"Probably {'open' if v.value else 'closed'}: {v.note}."
    if v.status == "OUTDATED":
        return f"Listed as {'open' if v.value else 'closed'} but the listing is old ({v.note}); confirm first."
    return f"Opening hours UNKNOWN ({v.note}). Not assumed open: call ahead."


def sos(engine, lat: float, lon: float) -> dict:
    """Simulated SOS: who would be notified + nearest emergency facilities."""
    hosp = need_now(engine, "hospital", lat, lon, limit=2)["results"]
    pol = need_now(engine, "police", lat, lon, limit=2)["results"]
    loc = mkview("sos:location", {"lat": lat, "lon": lon}, "KNOWN", 0.9, "device", False,
                 note="location shared with contacts (simulated)").model_dump()
    return {"simulated": True, "notified": ["Trusted contact 1 (simulated)", "Trusted contact 2 (simulated)"],
            "emergency_numbers": {"all_emergencies": "112", "police": "112", "women_helpline": "1091", "ambulance": "108"},
            "location": loc, "nearest_hospitals": hosp, "nearest_police": pol,
            "message": "Simulation only: no real message was sent."}

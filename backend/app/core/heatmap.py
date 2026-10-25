"""Night safety heatmap by hour: per grid cell, length-weighted risk of the
streets inside it (lighting, incident history for that hour, isolation and
emergency access given what is open at that hour). Weather is excluded (it is
not a property of a place)."""
from __future__ import annotations

import numpy as np

from .clock import night_time
from .risk import CI, edge_risk
from .world import CODE

PLACE_COMPONENTS = ("lighting", "incident", "isolation", "emergency", "traffic")


def heatmap(engine, hour: int) -> dict:
    s, st = engine.state, engine.static
    t = night_time(f"{hour % 24:02d}:30", st.night, st.tz)
    key = (hour % 24, s.available("osm_hours"), s.available("incident_history"))
    cache = getattr(engine, "_heat_cache", {})
    if key in cache:
        return cache[key]
    er = edge_risk(s, "walk", t, engine.cache)
    G, S = st.walk, st.walk_static
    n = st.grid.ncells
    L = G.elen
    w = st.risk_cfg["weights"]
    tot_w = sum(w[c] for c in PLACE_COMPONENTS)
    lo = sum(w[c] * er.lo[CI[c]] for c in PLACE_COMPONENTS) / tot_w
    hi = sum(w[c] * er.hi[CI[c]] for c in PLACE_COMPONENTS) / tot_w
    road = np.bincount(S.cell, weights=L, minlength=n)
    clo = np.bincount(S.cell, weights=L * lo, minlength=n) / np.maximum(road, 1)
    chi = np.bincount(S.cell, weights=L * hi, minlength=n) / np.maximum(road, 1)
    unk = np.bincount(S.cell, weights=L * (S.light_code == CODE["UNKNOWN"]), minlength=n) / np.maximum(road, 1)
    feats = []
    half = st.grid.size / 2
    for c in np.nonzero(road > 80)[0]:
        cx, cy = st.grid.center(int(c))
        la0, lo0 = st.proj.latlon(cx - half, cy - half)
        la1, lo1 = st.proj.latlon(cx + half, cy + half)
        safety_mid = 100 * (1 - (clo[c] + chi[c]) / 2)
        feats.append({"type": "Feature",
                      "geometry": {"type": "Polygon", "coordinates": [[[float(lo0), float(la0)], [float(lo1), float(la0)],
                                                                        [float(lo1), float(la1)], [float(lo0), float(la1)],
                                                                        [float(lo0), float(la0)]]]},
                      "properties": {"safety": round(float(safety_mid), 1), "safety_lo": round(float(100 * (1 - chi[c]))),
                                     "safety_hi": round(float(100 * (1 - clo[c]))),
                                     "lighting_unknown": round(float(unk[c]), 2),
                                     "status": "UNKNOWN" if unk[c] > 0.5 else "PROBABLE"}})
    out = {"type": "FeatureCollection", "hour": hour % 24, "features": feats, "synthetic_inputs": ["incident_history"]}
    cache[key] = out
    engine._heat_cache = cache
    return out

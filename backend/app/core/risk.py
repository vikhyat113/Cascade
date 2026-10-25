"""Risk scorer: per-edge risk intervals for six components, at a given time.

Components (each in [0, 1], as [lo, hi]):
  lighting   lit share (OSM lit / lamps = KNOWN, main-road prior = PROBABLE, else UNKNOWN -> wide)
  incident   hour-aware incident density (synthetic history) + live reports
  isolation  road class + distance to anything open (opt/pess bounds from open-state uncertainty)
  traffic    pedestrian exposure to fast roads / accidents; for cabs, congestion
  weather    rain / fog / wind exposure (live obs > forecast > UNKNOWN [0, 0.7])
  emergency  distance to the nearest open hospital / police

UNKNOWN never contributes a point value: it contributes a wide interval.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

import numpy as np

from ..adapters.traffic_sim import DEFAULT_KPH
from ..adapters.weather import rain_class
from .facts import Fact, FactView
from .services import EdgeOpenLayers, OpenCache
from .world import CODE

COMPONENTS = ("lighting", "incident", "isolation", "traffic", "weather", "emergency")
CI = {c: i for i, c in enumerate(COMPONENTS)}
COMPONENT_LABEL = {"lighting": "Lighting", "incident": "Incident history", "isolation": "Isolation",
                   "traffic": "Traffic & closures", "weather": "Weather exposure", "emergency": "Emergency access"}
RAIN_RISK = {"none": 0.02, "light": 0.3, "moderate": 0.55, "heavy": 0.85}
RAIN_WALK = {"none": (1.0, 1.0, 1.0), "light": (1.0, 0.97, 0.9), "moderate": (0.98, 0.92, 0.82),
             "heavy": (0.95, 0.85, 0.72)}
UNKNOWN_WIDEN = {CODE["KNOWN"]: 0.05, CODE["PROBABLE"]: 0.1, CODE["OUTDATED"]: 0.2, CODE["UNKNOWN"]: 0.25}


@dataclass
class WeatherAssessment:
    rain: Optional[str]
    fog: bool
    lo: float
    hi: float
    code: int
    view: FactView
    walk_factor: tuple[float, float, float]   # multipliers on (best, expected, worst) walking speed
    summary: str


@dataclass
class DriveTimes:
    tt_free: np.ndarray
    lo: np.ndarray
    exp: np.ndarray
    hi: np.ndarray
    code: np.ndarray
    conf: np.ndarray


@dataclass
class EdgeRisk:
    lo: np.ndarray            # (6, m)
    hi: np.ndarray
    code: np.ndarray          # (6, m) status codes
    blocked: np.ndarray       # (m,) bool
    weather: WeatherAssessment
    open: EdgeOpenLayers
    closures: list = field(default_factory=list)
    drive: Optional[DriveTimes] = None


def is_night(hour: int, cfg: dict) -> bool:
    start, end = cfg.get("night_hours", [19, 6])
    return hour >= start or hour < end


def forecast_fact(state, t: datetime) -> Optional[Fact]:
    st = state.static
    if not state.available("weather_forecast") or st.weather.fetched_at is None:
        return None
    row = st.weather.at(t)
    if row is None:
        return None
    c = st.source_cfg["weather_forecast"]
    return Fact(key=f"weather:fc:{t.strftime('%Y-%m-%dT%H')}", value=row, source="weather_forecast",
                synthetic=False, observed_at=st.weather.fetched_at, ttl_s=c["ttl_s"], reliability=c["reliability"],
                kind="inferred", note="Open-Meteo hourly forecast (cached)")


def assess_weather(state, t: datetime) -> WeatherAssessment:
    now = state.now()
    live = state.get("weather:now")
    live_st = state.status_of(live)
    fc = forecast_fact(state, t)
    fc_st = state.status_of(fc)
    near = abs((t - now).total_seconds()) <= 45 * 60
    if live_st in ("KNOWN", "PROBABLE") and near:
        f, st = live, live_st
    elif fc_st != "UNKNOWN":
        f, st = fc, fc_st
    elif live_st == "OUTDATED":
        f, st = live, live_st
    else:
        f, st = None, "UNKNOWN"
    if f is None or st == "UNKNOWN":
        v = state.view(f, key="weather", interval=(0.0, 0.7), source="weather_live",
                       note="no usable weather data: assuming anything from dry to heavy rain")
        return WeatherAssessment(None, False, 0.0, 0.7, CODE["UNKNOWN"], v, (1.0, 0.95, 0.8),
                                 "weather UNKNOWN")
    val = f.value or {}
    mm = val.get("rain_mm") if val.get("rain_mm") is not None else val.get("precip_mm")
    rc = val.get("rain_class") or rain_class(mm) or "none"
    fog = bool(val.get("fog")) or (val.get("visibility_m") is not None and val["visibility_m"] < 1000)
    base = RAIN_RISK[rc] + (0.25 if fog else 0.0) + (0.1 if (val.get("wind_kmh") or 0) > 40 else 0.0)
    p = (val.get("precip_prob") or 0) / 100.0
    if st == "KNOWN":
        lo, hi = base - 0.05, base + 0.05
    elif st == "PROBABLE":
        lo, hi = base - 0.1, base + 0.15 + 0.4 * p
    else:
        lo, hi = base - 0.2, base + 0.45
    lo, hi = float(np.clip(lo, 0, 1)), float(np.clip(hi, 0, 1))
    wf = RAIN_WALK[rc]
    if st == "OUTDATED":
        wf = (wf[0], wf[1] * 0.97, wf[2] * 0.9)
    v = state.view(f, interval=(round(lo, 3), round(hi, 3)))
    summary = f"{rc} rain" if rc != "none" else "dry"
    if fog:
        summary += ", fog"
    return WeatherAssessment(rc, fog, lo, hi, CODE[st], v, wf, summary)


def _memo(state, key, fn):
    """Per-instant cache: facts only change when the sim clock moves, so results for the
    same `now` (and inputs) can be reused across candidates and active plans."""
    cache = state.__dict__.setdefault("_risk_memo", {})
    now = state.now()
    if cache.get("_now") != now or cache.get("_v") != state.version:
        cache.clear()
        cache["_now"], cache["_v"] = now, state.version
    if key not in cache:
        cache[key] = fn()
    return cache[key]


def traffic_fact_codes(state, cells: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """For an array of traffic-cell indices: (speed_factor or nan, status code, confidence)."""
    return _memo(state, ("traffic", id(cells), len(cells)), lambda: _traffic_fact_codes(state, cells))


def _traffic_fact_codes(state, cells: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    uniq, inv = np.unique(cells, return_inverse=True)
    fac = np.full(len(uniq), np.nan)
    code = np.zeros(len(uniq), dtype=np.int8)
    conf = np.zeros(len(uniq))
    for k, c in enumerate(uniq):
        f = state.get(f"traffic:cell:{int(c)}")
        s = state.status_of(f)
        code[k] = CODE[s]
        if s != "UNKNOWN":
            fac[k] = float(f.value["speed_factor"])
            conf[k] = state.conf_of(f)
    return fac[inv], code[inv], conf[inv]


def drive_times(state, t: datetime) -> DriveTimes:
    return _memo(state, ("drive_times",), lambda: _drive_times(state))


def free_flow_tt(G) -> np.ndarray:
    """Free-flow seconds per drive edge (OSMnx speeds, class defaults where missing). Static."""
    kph = np.array([DEFAULT_KPH.get(h.replace("_link", ""), 25) for h in G.ehw], dtype=float)
    kph = np.where(np.isfinite(G.espeed), G.espeed, kph)
    return G.elen / (np.maximum(kph, 5.0) / 3.6)


def _drive_times(state) -> DriveTimes:
    st = state.static
    S = st.drive_static
    if getattr(S, "tt_free", None) is None:
        S.tt_free = free_flow_tt(st.drive)
    tt_free = S.tt_free
    fac, code, conf = traffic_fact_codes(state, S.tcell)
    f = np.where(np.isfinite(fac), np.maximum(fac, 0.1), 1.0)
    base = tt_free / f
    lo, exp, hi = base * 0.92, base.copy(), base * 1.12
    m = code == CODE["PROBABLE"]
    lo[m], hi[m] = base[m] * 0.85, base[m] * 1.3
    m = code == CODE["OUTDATED"]
    lo[m], exp[m], hi[m] = tt_free[m], base[m] * 1.1, base[m] * 1.7
    m = code == CODE["UNKNOWN"]
    lo[m], hi[m] = tt_free[m], tt_free[m] * 2.0
    exp[m] = (lo[m] + hi[m]) / 2          # interval midpoint, not an invented reading
    return DriveTimes(tt_free, lo, exp, hi, code, conf)


def active_closures(state) -> list[dict]:
    out = []
    for f in state.with_prefix("closure:"):
        v = f.value or {}
        if not v.get("active"):
            continue
        s = state.status_of(f)
        out.append({"id": f.key.split(":", 1)[1], "status": s, "fact": f, **{k: v.get(k) for k in
                    ("name", "reason", "kind", "lat", "lon", "walk_edges", "drive_edges")}})
    return out


def edge_risk(state, which: str, t: datetime, cache: OpenCache) -> EdgeRisk:
    st = state.static
    G, S = (st.walk, st.walk_static) if which == "walk" else (st.drive, st.drive_static)
    m = G.m
    lo = np.zeros((6, m))
    hi = np.zeros((6, m))
    code = np.zeros((6, m), dtype=np.int8)
    dark = 1.0 if is_night(t.hour, st.risk_cfg) else 0.25

    # lighting (static, from OSM + priors)
    i = CI["lighting"]
    lo[i], hi[i], code[i] = S.light_lo * dark, S.light_hi * dark, S.light_code

    # incident history + live reports
    i = CI["incident"]
    hb = state.heartbeat("incident_history")
    hs = state.status_of(hb)
    if hs != "UNKNOWN":
        v = st.incidents.at(S.cell, t.hour)
        lo[i], hi[i] = 0.8 * v, np.minimum(1.0, 1.2 * v + 0.05)
        code[i] = CODE[hs]
    else:
        lo[i], hi[i], code[i] = 0.0, 0.8, CODE["UNKNOWN"]
    for f in state.with_prefix("incident:live:"):
        s = state.status_of(f)
        if s == "UNKNOWN" or not f.value:
            continue
        ix, iy = st.proj.xy(f.value["lat"], f.value["lon"])
        near = np.hypot(G.emx - ix, G.emy - iy) < 250
        sev = float(f.value.get("severity", 0.5))
        hi[i, near] += 0.35 * sev
        if s in ("KNOWN", "PROBABLE"):
            lo[i, near] += 0.2 * sev
    if state.status_of(state.heartbeat("incident_reports")) in ("OUTDATED", "UNKNOWN"):
        hi[i] += 0.1                                   # recent incidents unseen

    # isolation + emergency (from open-state layers)
    ol = cache.edges(state, t, which)
    lo[CI["isolation"]], hi[CI["isolation"]], code[CI["isolation"]] = ol.iso_lo, ol.iso_hi, ol.iso_code
    lo[CI["emergency"]], hi[CI["emergency"]], code[CI["emergency"]] = ol.em_lo, ol.em_hi, ol.em_code

    # traffic & closures
    i = CI["traffic"]
    fac, tcode, _ = traffic_fact_codes(state, S.tcell)
    dt = None
    if which == "walk":
        lo[i] = S.walk_traffic
        widen = np.array([UNKNOWN_WIDEN[k] for k in range(4)])
        hi[i] = S.walk_traffic + widen[tcode]
        acc = np.isfinite(fac) & (fac < 0.6)
        lo[i, acc] += 0.2
        hi[i, acc] += 0.3
        code[i] = np.maximum(np.minimum(tcode, CODE["PROBABLE"]), 0)  # class-based exposure is inferred
        code[i][tcode == CODE["UNKNOWN"]] = CODE["UNKNOWN"]
    else:
        dt = drive_times(state, t)
        r_lo, r_hi = dt.lo / dt.tt_free, dt.hi / dt.tt_free
        lo[i] = np.clip((r_lo - 1) * 0.5, 0, 0.8) + 0.05
        hi[i] = np.clip((r_hi - 1) * 0.5, 0, 0.8) + 0.1
        code[i] = dt.code
    blocked = np.zeros(m, dtype=bool)
    closures = active_closures(state)
    for c in closures:
        edges = c.get("walk_edges" if which == "walk" else "drive_edges") or []
        if not edges:
            continue
        edges = np.asarray(edges, dtype=int)
        if c["status"] == "UNKNOWN":
            hi[i, edges] += 0.3                        # too old to trust: widen, do not block
        elif which == "drive" or c.get("kind") == "waterlogging":
            blocked[edges] = True                      # barricades stop vehicles; floods stop everyone
        else:
            lo[i, edges] += 0.2                        # pedestrians can pass a barricade / accident,
            hi[i, edges] += 0.35                       # but it is not a pleasant place at 2 AM

    # weather (same for every outdoor edge at this time)
    w = assess_weather(state, t)
    i = CI["weather"]
    lo[i], hi[i], code[i] = w.lo, w.hi, w.code
    if which == "walk" and w.rain in ("moderate", "heavy") and len(st.flood_walk):
        hi[i, st.flood_walk] += 0.15

    np.clip(lo, 0, 1, out=lo)
    np.clip(hi, 0, 1, out=hi)
    hi = np.maximum(hi, lo)
    return EdgeRisk(lo, hi, code, blocked, w, ol, closures, dt)


def path_components(er: EdgeRisk, idx: np.ndarray, lengths: np.ndarray, factor: Optional[dict] = None) -> dict:
    """Length-weighted risk per component over a path, plus status shares by length."""
    if len(idx) == 0:
        return {c: {"lo": 0.0, "hi": 0.0, "weights": {}} for c in COMPONENTS}
    L = lengths[idx]
    w = L / max(L.sum(), 1e-9)
    out = {}
    for c, k in CI.items():
        f = (factor or {}).get(c, 1.0)
        weights = np.bincount(er.code[k, idx], weights=L, minlength=4)
        out[c] = {"lo": float(er.lo[k, idx] @ w) * f, "hi": float(er.hi[k, idx] @ w) * f,
                  "weights": {"UNKNOWN": weights[0], "OUTDATED": weights[1], "PROBABLE": weights[2],
                              "KNOWN": weights[3]}}
    return out


def point_components(er: EdgeRisk, e: int, factor: Optional[dict] = None) -> dict:
    return path_components(er, np.array([e]), np.ones(er.lo.shape[1]), factor)


def combine(comp: dict, weights: dict) -> tuple[float, float]:
    tot = sum(weights.values())
    lo = sum(weights[c] * comp[c]["lo"] for c in COMPONENTS) / tot
    hi = sum(weights[c] * comp[c]["hi"] for c in COMPONENTS) / tot
    return float(lo), float(hi)


def edge_cost_risk(er: EdgeRisk, weights: dict) -> np.ndarray:
    """Uncertainty-averse per-edge risk used inside routing costs."""
    tot = sum(weights.values())
    w = np.array([weights[c] for c in COMPONENTS])[:, None] / tot
    mid = er.lo + 0.6 * (er.hi - er.lo)
    return (w * mid).sum(axis=0)


def round_time(t: datetime, minutes: int = 5) -> datetime:
    return t - timedelta(minutes=t.minute % minutes, seconds=t.second, microseconds=t.microsecond)

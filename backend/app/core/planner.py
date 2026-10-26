"""Planner: candidate generation -> forward-in-time evaluation -> robust selection.

Every time is propagated as a triple (best, expected, worst) in seconds after
departure; `inf` means "not possible in this case". Every risk is an interval.
The planner only reads Facts from the WorldState (never simulator truth).
"""
from __future__ import annotations

import hashlib
import math
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

import numpy as np
from pydantic import BaseModel, Field

from .cab import cab_wait
from .clock import hhmm, to_night
from .facts import STATUS_RANK, Fact, FactView, weakest
from .freshness import coverage_status, status_shares
from .risk import (COMPONENTS, CI, EdgeRisk, combine, edge_cost_risk, edge_risk, path_components,
                   round_time)
from .routing import compute_edge_cost, evaluate_candidate_routes, yen_k_shortest_loopless_paths
from .services import OpenCache, poi_view, safe_havens_near
from .world import CODE, STATUS_OF

INF = math.inf
CASES = ("best", "expected", "worst")
STATUS_CONF = {3: 0.75, 2: 0.45, 1: 0.2, 0: 0.0}
CATEGORY_LABEL = {
    "lighting": "Street lighting", "incidents": "Incident data", "isolation": "Open places nearby",
    "emergency": "Emergency access", "weather": "Weather", "traffic": "Traffic speeds",
    "closures": "Road closures", "transit_timing": "Transit timing", "cab_availability": "Cab availability",
}
CRITICAL = {"walk": ["closures", "weather"], "bus": ["transit_timing", "closures"],
            "metro": ["transit_timing", "closures"], "cab": ["cab_availability", "traffic", "closures"]}


# ---- request models -------------------------------------------------------------------
class Point(BaseModel):
    lat: float
    lon: float
    name: Optional[str] = None
    kind: Optional[str] = None          # "home" / "work" lets the simple UI say "Home by 2:58"


class Prefs(BaseModel):
    risk_weight: float = Field(0.7, ge=0.0, le=1.0)      # 0 = fastest, 1 = safest
    modes: list[str] = Field(default_factory=lambda: ["walk", "bus", "cab"])
    max_walk_m: float = 2500
    lambda_val: Optional[float] = None
    u: Optional[float] = None


class PlanRequest(BaseModel):
    origin: Point
    destination: Point
    start_time: Optional[str] = None
    finish_time: Optional[str] = None
    deadline: Optional[str] = None
    persona: Optional[str] = None
    prefs: Prefs = Field(default_factory=Prefs)
    lang: str = "en"                    # language of the simple view's sentences


# ---- route specs ---------------------------------------------------------------------------
@dataclass
class Leg:
    mode: str                         # walk | cab | bus | metro
    graph: Optional[str]              # walk | drive | None
    edges: list = field(default_factory=list)
    a: tuple = ()
    b: tuple = ()
    connector_m: float = 0.0
    route_id: Optional[str] = None
    direction: Optional[str] = None
    board: Optional[int] = None
    alight: Optional[int] = None


@dataclass
class RouteSpec:
    kind: str
    legs: list
    lam: float = 0.0
    sig: str = ""

    def signature(self) -> str:
        h = hashlib.sha1()
        for leg in self.legs:
            h.update(f"{leg.mode}|{leg.route_id}|{leg.board}|{leg.alight}|".encode())
            h.update(",".join(str(e) for e, _ in leg.edges).encode())
        self.sig = f"{self.kind}-{h.hexdigest()[:10]}"
        return self.sig


def mkview(key: str, value, st: str, conf: float, source: str, synthetic: bool, note: Optional[str] = None,
           interval=None, age_s=None, kind=None) -> FactView:
    """Aggregate fact view. Enforces the hard rule: UNKNOWN carries no value."""
    return FactView(key=key, value=None if st == "UNKNOWN" else value, status=st,
                    confidence=round(conf if st != "UNKNOWN" else 0.0, 3), source=source, age_s=age_s,
                    synthetic=synthetic, kind=kind, note=note, interval=interval)


# ---- context -----------------------------------------------------------------------------------
class Ctx:
    def __init__(self, state, req: PlanRequest, cache: OpenCache, departure: datetime):
        self.state = state
        self.st = state.static
        self.req = req
        self.cache = cache
        self.t0 = departure
        self.cfg = self.st.planner_cfg
        self.routing_cfg = getattr(self.st, "routing_cfg", {})
        self.weights = dict(self.st.risk_cfg["weights"])
        self.speeds = self.cfg["walk_speed_mps"]
        self._er: dict = {}
        self.req_deadline: Optional[datetime] = None
        self.notes: list[str] = []
        self.warnings: list[str] = []
        ox, oy = self.st.proj.xy(req.origin.lat, req.origin.lon)
        dx, dy = self.st.proj.xy(req.destination.lat, req.destination.lon)
        self.oxy, self.dxy = (float(ox), float(oy)), (float(dx), float(dy))

    def er(self, which: str, t: datetime) -> EdgeRisk:
        key = (which, round_time(t, 15))
        if key not in self._er:
            self._er[key] = edge_risk(self.state, which, key[1], self.cache)
        return self._er[key]

    def at(self, off_s: float) -> datetime:
        return self.t0 + timedelta(seconds=off_s if math.isfinite(off_s) else 0)


# ---- candidate generation ------------------------------------------------------------------
def _overlap(a: RouteSpec, b: RouteSpec, st) -> float:
    def es(spec):
        out = {}
        for leg in spec.legs:
            G = st.walk if leg.graph == "walk" else st.drive if leg.graph == "drive" else None
            if G is not None:
                for e, _ in leg.edges:
                    out[(leg.graph, e)] = float(G.elen[e])
        return out
    ea, eb = es(a), es(b)
    if not ea or not eb:
        return 1.0 if (not ea and not eb and a.kind == b.kind) else 0.0
    shared = sum(v for k, v in ea.items() if k in eb)
    return shared / max(sum(ea.values()), sum(eb.values()))


_YEN_CACHE: dict = {}


def walk_candidates(ctx: Ctx) -> list[RouteSpec]:
    st = ctx.st
    G = st.walk
    o, od = G.nearest_node(ctx.req.origin.lat, ctx.req.origin.lon)
    d, dd = G.nearest_node(ctx.req.destination.lat, ctx.req.destination.lon)
    er = ctx.er("walk", ctx.t0)

    rcfg = getattr(ctx, "routing_cfg", {})
    lam = ctx.req.prefs.lambda_val if getattr(ctx.req.prefs, "lambda_val", None) is not None else (ctx.req.prefs.risk_weight * 2.0)
    u = ctx.req.prefs.u if getattr(ctx.req.prefs, "u", None) is not None else float(rcfg.get("u", 0.5))
    k_exp = float(rcfg.get("k_exposure", ctx.cfg.get("risk_cost_s_per_m", 0.8)))

    # 1. Multi-route engine: Yen's K-shortest paths under safety-aware cost
    cost = compute_edge_cost(G, "walk", er, ctx.weights, ctx.speeds, lam, u, k_exp)
    blocked_tuple = tuple(int(e) for e in np.where(er.blocked)[0]) if er.blocked is not None and er.blocked.any() else ()
    cache_key = ("walk", getattr(G, "generated_at", None), o, d, round_time(ctx.t0, 15),
                 round(lam, 2), round(u, 2), blocked_tuple)

    if cache_key in _YEN_CACHE:
        kept_paths = _YEN_CACHE[cache_key]
    else:
        k_paths = int(rcfg.get("k_paths", 8))
        max_k = int(rcfg.get("max_k_paths", 12))
        t_budget = float(rcfg.get("time_budget_s", 1.5))
        c_buff = float(rcfg.get("corridor_buffer_m", 1500.0))
        ov_max = float(rcfg.get("overlap_max", 0.7))
        c_ratio = float(rcfg.get("cost_ratio_max", 1.6))
        div_n = int(rcfg.get("diverse_n", 4))

        kept_paths, _, _, _ = yen_k_shortest_loopless_paths(
            G, o, d, cost, er.blocked, K=k_paths, max_K=max_k,
            time_budget_s=t_budget, corridor_buffer_m=c_buff,
            overlap_max=ov_max, cost_ratio_max=c_ratio, diverse_n=div_n
        )
        if len(_YEN_CACHE) > 120:
            _YEN_CACHE.clear()
        _YEN_CACHE[cache_key] = kept_paths

    out = []
    for _, path, _ in kept_paths:
        out.append(RouteSpec("walk", [Leg("walk", "walk", path, _pt(ctx.req.origin), _pt(ctx.req.destination),
                                          connector_m=od + dd)], lam))

    # Baseline lambda paths for scenario continuity and extreme preferences (e.g. 0 = pure fastest, 4 = pure safest)
    risk = edge_cost_risk(er, ctx.weights)
    base = G.elen / ctx.speeds["expected"]
    K = ctx.cfg["risk_cost_s_per_m"]
    for l_val in ctx.cfg["lambdas"]:
        path = G.shortest_path(o, d, base + l_val * K * G.elen * risk, er.blocked)
        if path is not None:
            out.append(RouteSpec("walk", [Leg("walk", "walk", path, _pt(ctx.req.origin), _pt(ctx.req.destination),
                                              connector_m=od + dd)], l_val))
    return out


def cab_candidates(ctx: Ctx) -> list[RouteSpec]:
    st = ctx.st
    G = st.drive
    o, od = G.nearest_node(ctx.req.origin.lat, ctx.req.origin.lon)
    d, dd = G.nearest_node(ctx.req.destination.lat, ctx.req.destination.lon)
    er = ctx.er("drive", ctx.t0)
    dt = er.drive

    rcfg = getattr(ctx, "routing_cfg", {})
    lam = ctx.req.prefs.lambda_val if getattr(ctx.req.prefs, "lambda_val", None) is not None else (ctx.req.prefs.risk_weight * 2.0)
    u = ctx.req.prefs.u if getattr(ctx.req.prefs, "u", None) is not None else float(rcfg.get("u", 0.5))
    k_exp = float(rcfg.get("k_exposure", 0.8))

    cost = compute_edge_cost(G, "drive", er, ctx.weights, ctx.speeds, lam, u, k_exp)
    blocked_tuple = tuple(int(e) for e in np.where(er.blocked)[0]) if er.blocked is not None and er.blocked.any() else ()
    cache_key = ("drive", getattr(G, "generated_at", None), o, d, round_time(ctx.t0, 15),
                 round(lam, 2), round(u, 2), blocked_tuple)

    if cache_key in _YEN_CACHE:
        kept_paths = _YEN_CACHE[cache_key]
    else:
        k_paths = int(rcfg.get("k_paths", 8))
        max_k = int(rcfg.get("max_k_paths", 12))
        t_budget = float(rcfg.get("time_budget_s", 1.5))
        c_buff = float(rcfg.get("corridor_buffer_m", 1500.0))
        ov_max = float(rcfg.get("overlap_max", 0.7))
        c_ratio = float(rcfg.get("cost_ratio_max", 1.6))
        div_n = int(rcfg.get("diverse_n", 4))

        kept_paths, _, _, _ = yen_k_shortest_loopless_paths(
            G, o, d, cost, er.blocked, K=k_paths, max_K=max_k,
            time_budget_s=t_budget, corridor_buffer_m=c_buff,
            overlap_max=ov_max, cost_ratio_max=c_ratio, diverse_n=div_n
        )
        if len(_YEN_CACHE) > 120:
            _YEN_CACHE.clear()
        _YEN_CACHE[cache_key] = kept_paths

    out = []
    for _, path, _ in kept_paths:
        out.append(RouteSpec("cab", [Leg("cab", "drive", path, _pt(ctx.req.origin), _pt(ctx.req.destination),
                                         connector_m=od + dd)], lam))

    risk = edge_cost_risk(er, ctx.weights)
    for l_val in (0.0, 1.0):
        path = G.shortest_path(o, d, dt.exp + l_val * 0.3 * G.elen * risk, er.blocked)
        if path:
            out.append(RouteSpec("cab", [Leg("cab", "drive", path, _pt(ctx.req.origin), _pt(ctx.req.destination),
                                             connector_m=od + dd)], l_val))
    return out


def transit_candidates(ctx: Ctx, mode: str) -> list[RouteSpec]:
    st, tn = ctx.st, ctx.st.transit
    if tn is None:
        return []
    r_access = ctx.cfg["max_access_walk_m"] / 1.25
    near_o = [s for s in tn.stops_near(*ctx.oxy, r_access) if tn.routes[s[0]].mode == mode]
    near_d = [s for s in tn.stops_near(*ctx.dxy, r_access) if tn.routes[s[0]].mode == mode]
    combos = []
    for rid, kb, db in near_o:
        for rid2, ka, da in near_d:
            if rid2 != rid or ka == kb:
                continue
            route = tn.routes[rid]
            lo, hi = sorted((kb, ka))
            ride = sum(route.seg_s[lo:hi])
            combos.append(((db + da) * 1.3 / ctx.speeds["expected"] + ride, rid, kb, ka, db, da))
    combos.sort()
    seen, picked = set(), []
    for c in combos:
        if c[1] in seen and len(picked) >= 2:
            continue
        seen.add(c[1])
        picked.append(c)
        if len(picked) >= 4:
            break
    G = st.walk
    er = ctx.er("walk", ctx.t0)
    risk = edge_cost_risk(er, ctx.weights)
    cost = G.elen / ctx.speeds["expected"] + 1.0 * ctx.cfg["risk_cost_s_per_m"] * G.elen * risk
    o, od = G.nearest_node(ctx.req.origin.lat, ctx.req.origin.lon)
    d, dd = G.nearest_node(ctx.req.destination.lat, ctx.req.destination.lon)
    out = []
    for _, rid, kb, ka, _, _ in picked:
        route = tn.routes[rid]
        sb, sa = route.stops[kb], route.stops[ka]
        nb, nbd = G.nearest_node(sb.lat, sb.lon)
        na, nad = G.nearest_node(sa.lat, sa.lon)
        p1 = G.shortest_path(o, nb, cost, er.blocked)
        p2 = G.shortest_path(na, d, cost, er.blocked)
        if p1 is None or p2 is None:
            continue
        legs = [Leg("walk", "walk", p1, _pt(ctx.req.origin), (sb.lat, sb.lon, sb.name), connector_m=od + nbd),
                Leg(mode, None, [], (sb.lat, sb.lon, sb.name), (sa.lat, sa.lon, sa.name), route_id=rid,
                    direction="A" if ka > kb else "B", board=kb, alight=ka),
                Leg("walk", "walk", p2, (sa.lat, sa.lon, sa.name), _pt(ctx.req.destination), connector_m=nad + dd)]
        out.append(RouteSpec(mode, legs, 1.0))
    return out


def _pt(p: Point) -> tuple:
    return (p.lat, p.lon, p.name or "")


# ---- evaluation -----------------------------------------------------------------------------------
@dataclass
class TripTiming:
    trip: object
    board: tuple
    alight: tuple
    view: FactView
    status: str
    conf: float
    cancelled: bool
    maybe_cancelled: bool
    note: str
    conflict: Optional[str] = None


def trip_timing(ctx: Ctx, trip, kb: int, ka: int) -> Optional[TripTiming]:
    s, tn = ctx.state, ctx.st.transit
    pb, pa = trip.pos_of(kb), trip.pos_of(ka)
    if pb is None or pa is None or pa <= pb:
        return None
    sb, sa = trip.times[pb], trip.times[pa]
    src = s.sources["transit_schedule"]
    sched = None
    if s.available("transit_schedule"):
        sched = Fact(key=f"transit:sched:{trip.id}", value=sb.isoformat(timespec="minutes"),
                     source="transit_schedule", synthetic=tn.synthetic, observed_at=tn.generated_at,
                     ttl_s=src.ttl_s, reliability=src.reliability, kind="scheduled",
                     note=f"timetable: {hhmm(sb)}")
    rt = s.get(f"transit:rt:{trip.id}")
    rs = s.status_of(rt)
    conflict = None
    cancelled = maybe = False
    ride = (sa - sb).total_seconds()
    if rs in ("KNOWN", "PROBABLE"):
        d = float(rt.value["delay_s"])
        cancelled = bool(rt.value["cancelled"])
        lo_b, hi_b = (-30, 90) if rs == "KNOWN" else (-60, 240)
        used, st_used = rt, rs
        if sched is not None and (cancelled or abs(d) > 300):
            conflict = (f"timetable says {hhmm(sb)}, realtime says "
                        + ("CANCELLED" if cancelled else f"{int(d // 60)} min late") + " -> trusting newer observation")
            sched = sched.model_copy(update={"contradicted_by": rt.key})
        note = "cancelled (realtime)" if cancelled else f"realtime {rs}: {'+' if d >= 0 else ''}{int(d // 60)} min"
    elif rs == "OUTDATED" or sched is not None:
        if rs == "OUTDATED":
            # old delay kept but band widened to cover "back on time" .. "much later"
            d = float(rt.value["delay_s"])
            maybe = bool(rt.value["cancelled"])
            lo_b = -90 + min(d, 0) - d
            hi_b = max(d, 0) + 600 - d
        else:
            d, lo_b, hi_b = 0.0, -60, 480        # timetable only: buses run early 1 / late 8 min
        used = sched if sched is not None else rt
        st_used = s.status_of(used)
        age = s.view(rt).age_s if rt else None
        note = (f"realtime OUTDATED (last seen {int((age or 0) // 60)} min ago); using timetable"
                if rs == "OUTDATED" else "timetable only (no realtime)")
        if rs == "OUTDATED" and sched is None:
            note = "realtime OUTDATED and timetable unavailable"
    else:
        return None     # neither realtime nor timetable: timing UNKNOWN -> cannot plan this trip
    board = (sb + timedelta(seconds=d + lo_b), sb + timedelta(seconds=d), sb + timedelta(seconds=d + hi_b))
    alight = (sa + timedelta(seconds=d + lo_b - 0.05 * ride), sa + timedelta(seconds=d),
              sa + timedelta(seconds=d + hi_b + 0.15 * ride))
    v = s.view(used, interval=None)
    return TripTiming(trip, board, alight, v, st_used, s.conf_of(used), cancelled, maybe, note, conflict)


class PlanEval:
    """Accumulates segments for one candidate while simulating forward in time."""

    def __init__(self, ctx: Ctx, spec: RouteSpec):
        self.ctx, self.spec = ctx, spec
        self.cur = [0.0, 0.0, 0.0]
        self.segments: list[dict] = []
        self.parts: list[tuple[float, str, dict]] = []    # (exp duration, exposure, comps)
        self.cats: dict[str, dict] = {}
        self.walk_m = 0.0
        self.dist_m = 0.0
        self.invalid: Optional[str] = None
        self.extra_warn: list[str] = []
        self.timing: Optional[TripTiming] = None
        self.havens: list[dict] = []
        self.along: dict[str, dict] = {}       # open places passed on foot (id -> poi view)
        self.coords: list = []

    def times(self, offs) -> dict:
        t0 = self.ctx.t0
        return {c: (t0 + timedelta(seconds=o)).isoformat(timespec="seconds") if math.isfinite(o) else None
                for c, o in zip(CASES, offs)}

    def add_cat(self, name: str, st: str, conf: float, detail: str, weight: float = 1.0) -> None:
        c = self.cats.get(name)
        if c is None or STATUS_RANK[st] < STATUS_RANK[c["status"]] or (st == c["status"] and conf < c["confidence"]):
            self.cats[name] = {"name": name, "label": CATEGORY_LABEL[name], "status": st,
                               "confidence": round(conf, 3), "detail": detail}

    def coverage_cat(self, name: str, weights: dict, conf: float, detail: str) -> None:
        if sum(weights.values()) <= 0:
            return
        prev = self.cats.get(name)
        if prev and "_w" in prev:
            weights = {k: weights.get(k, 0) + prev["_w"].get(k, 0) for k in weights}
            conf = (conf + prev["confidence"]) / 2
        stt = coverage_status(weights, self.ctx.st.fc.coverage_threshold)
        self.cats[name] = {"name": name, "label": CATEGORY_LABEL[name], "status": stt,
                           "confidence": round(conf, 3), "detail": detail, "_w": weights}

    # -- walk -------------------------------------------------------------------------------
    def walk(self, leg: Leg) -> None:
        ctx, st = self.ctx, self.ctx.st
        G = st.walk
        er = ctx.er("walk", ctx.at(self.cur[1]))
        idx = np.array([e for e, _ in leg.edges], dtype=int)
        if len(idx) and er.blocked[idx].any():
            names = {G.ename[e] or "a street" for e in idx[er.blocked[idx]]}
            self.invalid = f"route crosses a closure ({', '.join(sorted(names))})"
            return
        dist = float(G.elen[idx].sum()) + leg.connector_m
        wf = er.weather.walk_factor
        sp = ctx.speeds
        dur = [dist / (sp["best"] * wf[0]), dist / (sp["expected"] * wf[1]), dist / (sp["worst"] * wf[2])]
        comps = path_components(er, idx, G.elen) if len(idx) else _point_comps(er, G, leg.a)
        start = list(self.cur)
        self.cur = [a + b for a, b in zip(self.cur, dur)]
        self.walk_m += dist
        self.dist_m += dist
        self.parts.append((dur[1], "outdoor", comps))
        coords = [[leg.a[1], leg.a[0]]] + (G.path_coords(leg.edges) if len(idx) else []) + [[leg.b[1], leg.b[0]]]
        self.coords.extend(coords)
        facts = self._walk_facts(er, idx, comps)
        self._safety_cats(er, idx, comps)
        self._open_along(idx, ctx.at(start[1]))
        self.segments.append(self._seg("walk", f"Walk {_m(dist)}" + _via(G, idx), leg, start, self.cur,
                                       dist, coords, comps, facts))

    def _walk_facts(self, er: EdgeRisk, idx, comps) -> list[dict]:
        st = self.ctx.st
        S = st.walk_static
        L = st.walk.elen[idx] if len(idx) else np.array([1.0])
        out = []
        if len(idx):
            w = comps["lighting"]["weights"]
            tot = max(sum(w.values()), 1e-9)
            lit_known = float(L[(S.light_code[idx] == CODE["KNOWN"]) & (S.light_lo[idx] < 0.3)].sum() / tot)
            prior = w["PROBABLE"] / tot
            unk = w["UNKNOWN"] / tot
            lst = coverage_status(w, st.fc.coverage_threshold)
            out.append(mkview("lighting:segment", f"{lit_known:.0%} mapped lit, {prior:.0%} main-road prior",
                              lst, float((S.light_conf[idx] * L).sum() / L.sum()), "osm_map", False,
                              note=f"{unk:.0%} of this stretch has no lighting data",
                              interval=(round(comps['lighting']['lo'], 2), round(comps['lighting']['hi'], 2))).model_dump())
            k = int(idx[np.argmin(er.open.em_dist[idx])])
            em_i = int(er.open.em_idx[k])
            layer = self.ctx.cache.layer(self.ctx.state, self.ctx.at(self.cur[1]))
            if em_i >= 0 and er.open.em_dist[k] < 3000:
                p, f, s_, c_ = layer.items[em_i]
                v = self.ctx.state.view(f)
                out.append(mkview("emergency:nearest", f"{p.label} ({_m(float(er.open.em_dist[k]))} from route)",
                                  v.status, v.confidence, v.source, False, note=v.note).model_dump())
            else:
                out.append(mkview("emergency:nearest", None, "UNKNOWN", 0, "osm_hours", False,
                                  note="no hospital / police confirmed open within 3 km").model_dump())
        out.append(er.weather.view.model_dump())
        return out

    def _open_along(self, idx, t: datetime) -> None:
        """Places confirmed or probably open within 80 m of the walking route, in route order."""
        if len(idx) == 0:
            return
        st, layer = self.ctx.st, self.ctx.cache.layer(self.ctx.state, t)
        tree, sel = layer.act_pess
        if tree is None:
            return
        pts = np.c_[st.walk.emx[idx], st.walk.emy[idx]]
        for (x, y), hits in zip(pts, tree.query_ball_point(pts, 80.0)):      # one batched query
            for k in hits:
                p = layer.items[sel[k]][0]
                if p.id not in self.along and p.cat not in ("atm",):
                    self.along[p.id] = poi_view(self.ctx.state, p, t, float(np.hypot(p.x - x, p.y - y)))

    def _safety_cats(self, er: EdgeRisk, idx, comps) -> None:
        st = self.ctx.st
        if len(idx) == 0:
            return
        L = st.walk.elen[idx]
        S = st.walk_static
        conf_l = float((S.light_conf[idx] * L).sum() / L.sum())
        sh = status_shares(comps["lighting"]["weights"])
        self.coverage_cat("lighting", comps["lighting"]["weights"], conf_l,
                          f"{sh['KNOWN']:.0%} mapped, {sh['PROBABLE']:.0%} main-road prior, {sh['UNKNOWN']:.0%} no data")
        iso_conf = sum(STATUS_CONF[CODE[k]] * v for k, v in comps["isolation"]["weights"].items()) / max(L.sum(), 1)
        self.coverage_cat("isolation", comps["isolation"]["weights"], iso_conf, "open-state of places along the way")
        hs = self.ctx.state.source_view("incident_history")
        rs = self.ctx.state.source_view("incident_reports")
        inc_st = weakest([hs.status, "PROBABLE" if rs.status in ("KNOWN", "PROBABLE") else rs.status])
        self.add_cat("incidents", inc_st, min(hs.confidence, max(rs.confidence, 0.2)),
                     f"history {hs.status} (synthetic), live reports {rs.status}")
        k = int(idx[np.argmin(er.open.em_dist[idx])])
        em_code = int(er.open.em_code[k])
        self.add_cat("emergency", STATUS_OF[em_code], STATUS_CONF[em_code],
                     f"nearest open hospital/police {_m(float(er.open.em_dist[k]))} from route"
                     if er.open.em_dist[k] < 3000 else "none confirmed open within 3 km")
        w = er.weather
        self.add_cat("weather", w.view.status, w.view.confidence, w.summary)

    # -- cab --------------------------------------------------------------------------------------
    def cab(self, leg: Leg) -> None:
        ctx, st, s = self.ctx, self.ctx.st, self.ctx.state
        G = st.drive
        er = ctx.er("drive", ctx.at(self.cur[1]))
        idx = np.array([e for e, _ in leg.edges], dtype=int)
        if len(idx) and er.blocked[idx].any():
            hit = set(int(e) for e in idx[er.blocked[idx]])
            names = sorted({c["name"] for c in er.closures if hit & set(c.get("drive_edges") or [])})
            self.invalid = "cab route crosses a closure" + (f" ({', '.join(names)})" if names else "")
            return
        cw = cab_wait(s, leg.a[0], leg.a[1], ctx.at(self.cur[1]))
        walk_s = leg.connector_m / ctx.speeds["expected"]
        wait = [cw["lo"], cw["exp"], cw["hi"]]
        start = list(self.cur)
        self.cur = [a + b for a, b in zip(self.cur, wait)]
        wcomps = _point_comps(ctx.er("walk", ctx.at(start[1])), st.walk, leg.a)
        self.parts.append((wait[1], "outdoor", wcomps))
        cv = cw["view"]
        self.segments.append(self._seg("wait", f"Book a cab / auto: wait {_mins(wait)}", leg, start, self.cur, 0,
                                       [[leg.a[1], leg.a[0]]], wcomps, [cv.model_dump()]))
        self.segments[-1]["cab"] = True
        if cv.source != "cab_availability":
            basis = "prior model, no live data"
        elif cv.status == "OUTDATED":
            basis = f"last live reading {int((cv.age_s or 0) // 60)} min old"
        else:
            basis = "live feed"
        self.add_cat("cab_availability", cv.status, cv.confidence,
                     f"wait {cw['lo'] / 60:.0f}-{cw['hi'] / 60:.0f} min ({basis})")
        dt = er.drive
        ride = [float(dt.lo[idx].sum()) + walk_s * 0.8, float(dt.exp[idx].sum()) + walk_s,
                float(dt.hi[idx].sum()) + walk_s * 1.3]
        vf = st.risk_cfg["vehicle_factor"]
        comps = path_components(er, idx, G.elen, {"lighting": vf, "isolation": vf, "incident": vf, "weather": 0.3})
        s0 = list(self.cur)
        self.cur = [a + b for a, b in zip(self.cur, ride)]
        dist = float(G.elen[idx].sum())
        self.dist_m += dist
        self.walk_m += leg.connector_m
        self.parts.append((ride[1], "vehicle", comps))
        coords = G.path_coords(leg.edges)
        self.coords.extend(coords)
        tw = comps["traffic"]["weights"]
        tconf = float((dt.conf[idx] * G.elen[idx]).sum() / max(G.elen[idx].sum(), 1))
        sh = status_shares(tw)
        self.coverage_cat("traffic", tw, tconf,
                          f"{sh['KNOWN']:.0%} live, {sh['PROBABLE'] + sh['OUTDATED']:.0%} stale, {sh['UNKNOWN']:.0%} unknown")
        tview = mkview("traffic:route", f"{dist / max(ride[1], 1) * 3.6:.0f} km/h average",
                       coverage_status(tw, st.fc.coverage_threshold), tconf, "traffic_live", True,
                       interval=(round(ride[0] / 60, 1), round(ride[2] / 60, 1)),
                       note="ride minutes range from per-road traffic facts")
        self.segments.append(self._seg("cab", f"Cab {_m(dist)}" + _via(G, idx), leg, s0, self.cur, dist, coords,
                                       comps, [tview.model_dump(), er.weather.view.model_dump()]))
        self.add_cat("weather", er.weather.view.status, er.weather.view.confidence, er.weather.summary)

    # -- bus / metro ------------------------------------------------------------------------------
    def transit(self, leg: Leg) -> None:
        ctx, st, s = self.ctx, self.ctx.st, self.ctx.state
        tn = st.transit
        route = tn.routes[leg.route_id]
        arr = [ctx.at(o) if math.isfinite(o) else None for o in self.cur]
        trips = tn.trips_after(route.id, leg.direction, leg.board, arr[0] or ctx.t0, limit=8)
        timings = [tt for tt in (trip_timing(ctx, tr, leg.board, leg.alight) for tr in trips) if tt]
        if not timings:
            nxt = tn.next_departure_after(route.id, arr[1] or ctx.t0)
            self.invalid = (f"{route.name}: no service" + (f" until {hhmm(nxt)}" if nxt else " tonight")
                            if s.available("transit_schedule")
                            else f"{route.id} timing UNKNOWN: timetable unavailable and realtime too old to use")
            return
        buf = timedelta(seconds=ctx.cfg["stop_buffer_s"])

        def pick(case: int) -> Optional[TripTiming]:
            a = arr[case]
            if a is None:
                return None
            for tt in timings:
                if tt.cancelled:
                    continue
                if case == 0 and tt.board[1] >= a:
                    return tt
                if case == 1 and tt.board[1] >= a + buf:
                    return tt
                if case == 2 and not tt.maybe_cancelled and tt.board[0] >= a:
                    return tt
            return None

        chosen = [pick(i) for i in range(3)]
        if chosen[1] is None and chosen[0] is None:
            self.invalid = f"{route.name}: no catchable trip (cancelled or departed)"
            return
        ref = chosen[1] or chosen[0]
        self.timing = ref
        t0 = ctx.t0
        board_off = [((c.board[k] - t0).total_seconds() if c else INF) for k, c in enumerate(chosen)]
        alight_off = [((c.alight[k] - t0).total_seconds() if c else INF) for k, c in enumerate(chosen)]
        # keep best <= expected <= worst
        alight_off[0] = min(alight_off[0], alight_off[1])
        alight_off[2] = max(alight_off[2], alight_off[1])
        wait_exp = max(0.0, board_off[1] - self.cur[1]) if math.isfinite(board_off[1]) else 0.0
        stop = route.stops[leg.board]
        haven = []
        if wait_exp > 240:
            haven = safe_havens_near(s, ctx.cache, ctx.at(self.cur[1]), stop.x, stop.y,
                                     ctx.cfg["safe_haven_radius_m"], limit=1)
        wcomps = _point_comps(ctx.er("walk", ctx.at(self.cur[1])), st.walk, (stop.lat, stop.lon))
        if haven:
            hw = st.risk_cfg["safe_haven_wait_risk"]
            wcomps = {c: {"lo": min(v["lo"], hw), "hi": min(v["hi"], hw * 2), "weights": v["weights"]}
                      for c, v in wcomps.items()}
            self.havens.extend(haven)
        start = list(self.cur)
        wait_end = [max(a, b) if math.isfinite(b) else INF for a, b in zip(self.cur, board_off)]
        self.parts.append((wait_exp, "haven" if haven else "outdoor", wcomps))
        where = f"at {haven[0]['name']} ({haven[0]['dist_m']} m from the stop)" if haven else f"at {stop.name}"
        tv = ref.view.model_dump()
        tv["note"] = ref.note
        wait_facts = [tv] + ([haven[0]["open"]] if haven else [])
        self.segments.append(self._seg("wait", f"Wait {where} for the {hhmm(ref.board[1])} {route.id}"
                                       + f" (~{wait_exp / 60:.0f} min)", leg, start, wait_end, 0,
                                       [[stop.lon, stop.lat]], wcomps, wait_facts))
        self.segments[-1].update({"trip_id": ref.trip.id, "route_id": route.id,
                                  "haven": haven[0]["name"] if haven else None})
        self.cur = wait_end
        er = ctx.er("walk", ctx.at(self.cur[1]))
        rf = st.risk_cfg["transit_ride_factor"]
        ride_comps = {c: {"lo": v["lo"] * (0 if c == "weather" else rf), "hi": v["hi"] * (0 if c == "weather" else rf),
                          "weights": v["weights"]} for c, v in _point_comps(er, st.walk, (stop.lat, stop.lon)).items()}
        s0 = list(self.cur)
        self.cur = alight_off
        lo_i, hi_i = sorted((leg.board, leg.alight))
        ride_m = sum(route.seg_s[lo_i:hi_i]) * (7.0 if route.mode == "bus" else 11.0)
        self.dist_m += ride_m
        self.parts.append(((alight_off[1] - s0[1]) if math.isfinite(alight_off[1]) else 0, "vehicle", ride_comps))
        stops = route.stops[lo_i:hi_i + 1]
        coords = [[x.lon, x.lat] for x in (stops if leg.alight > leg.board else stops[::-1])]
        self.coords.extend(coords)
        self.segments.append(self._seg(route.mode, f"{route.name.split(':')[0]} {route.stops[leg.board].name} -> "
                                       f"{route.stops[leg.alight].name}", leg, s0, self.cur, ride_m, coords,
                                       ride_comps, [tv]))
        self.segments[-1].update({"trip_id": ref.trip.id, "route_id": route.id, "color": route.color})
        self.add_cat("transit_timing", ref.status, ref.conf, f"{route.id} {hhmm(ref.board[1])}: {ref.note}")
        if ref.conflict:
            self.extra_warn.append(f"Conflicting sources for {route.id}: {ref.conflict}")
        later = [tt for tt in timings if tt.trip.start > ref.trip.start and not tt.cancelled
                 and (tt.board[1] - ref.board[1]).total_seconds() < 90 * 60]
        if not later:
            nxt = tn.next_departure_after(route.id, ref.trip.start + timedelta(minutes=1))
            self.extra_warn.append(f"This is the last {route.id} for a while ({hhmm(ref.board[1])}, timing {ref.status}); "
                                   + (f"next service {hhmm(nxt)}" if nxt else "no later service tonight"))
        if chosen[2] is None:
            self.extra_warn.append(f"Worst case misses the last catchable {route.id} trip")

    # -- helpers ------------------------------------------------------------------------------------
    def _seg(self, mode, label, leg, start, end, dist, coords, comps, facts) -> dict:
        lo, hi = combine(comps, self.ctx.weights)
        sts = [f["status"] for f in facts if isinstance(f, dict) and "status" in f]
        return {"mode": mode, "label": label, "from": leg.a[2] if len(leg.a) > 2 else "",
                "to": leg.b[2] if len(leg.b) > 2 else "", "start": self.times(start), "end": self.times(end),
                "duration_s": {c: (round(e - s) if math.isfinite(e) and math.isfinite(s) else None)
                               for c, s, e in zip(CASES, start, end)},
                "distance_m": round(dist), "geometry": coords,
                "risk": {c: {"lo": round(v["lo"], 3), "hi": round(v["hi"], 3)} for c, v in comps.items()},
                "safety": {"lo": round(100 * (1 - hi)), "hi": round(100 * (1 - lo))},
                "status": weakest(sts) if sts else "PROBABLE", "facts": facts}


def _point_comps(er: EdgeRisk, G, pt) -> dict:
    x, y = er_proj(G, pt)
    _, e = G.edge_tree.query([x, y])
    return path_components(er, np.array([int(e)]), G.elen)


def er_proj(G, pt):
    x, y = G.proj.xy(pt[0], pt[1])
    return float(x), float(y)


def _cap(s: str) -> str:
    return s[:1].upper() + s[1:]


def data_is(label: str, status: str) -> str:
    """'data on traffic speeds is only PROBABLE' / 'data on traffic speeds is UNKNOWN'."""
    return f"data on {label.lower()} is {'only ' if status == 'PROBABLE' else ''}{status}"


def _m(d: float) -> str:
    return f"{d / 1000:.1f} km" if d >= 1000 else f"{int(round(d / 10) * 10)} m"


def _mins(tri) -> str:
    return f"{tri[0] / 60:.0f}-{tri[2] / 60:.0f} min"


def _via(G, idx) -> str:
    if len(idx) == 0:
        return ""
    by = {}
    for e in idx:
        if G.ename[e]:
            by[G.ename[e]] = by.get(G.ename[e], 0) + G.elen[e]
    top = [n for n, _ in sorted(by.items(), key=lambda kv: -kv[1])[:2]]
    return f" via {', '.join(top)}" if top else ""


def evaluate(ctx: Ctx, spec: RouteSpec) -> Optional[dict]:
    pe = PlanEval(ctx, spec)
    for leg in spec.legs:
        if leg.mode == "walk":
            pe.walk(leg)
        elif leg.mode == "cab":
            pe.cab(leg)
        else:
            pe.transit(leg)
        if pe.invalid:
            return {"invalid": pe.invalid, "kind": spec.kind}
    st = ctx.st
    # closures feed status applies to every plan
    cv = ctx.state.source_view("closures_feed")
    n_cl = len([c for c in ctx.er("walk", ctx.t0).closures if c["status"] != "UNKNOWN"])
    pe.add_cat("closures", cv.status, cv.confidence, f"{n_cl} active closure(s) known; feed {cv.status}")
    # plan-level risk: exposure-time weighted, scaled by time spent outdoors
    tot = sum(max(d, 1.0) for d, _, _ in pe.parts) or 1.0
    comps = {c: {"lo": sum(max(d, 1.0) * p[c]["lo"] for d, _, p in pe.parts) / tot,
                 "hi": sum(max(d, 1.0) * p[c]["hi"] for d, _, p in pe.parts) / tot} for c in COMPONENTS}
    outdoor_min = sum(d for d, kind, _ in pe.parts if kind == "outdoor") / 60
    mult = 0.8 + 0.4 * min(1.0, outdoor_min / 45)
    r_lo, r_hi = combine(comps, ctx.weights)
    r_lo, r_hi = min(1.0, r_lo * mult), min(1.0, r_hi * mult)
    cats = {k: {kk: vv for kk, vv in v.items() if kk != "_w"} for k, v in pe.cats.items()}
    crit = [c for c in CRITICAL[spec.kind] if c in cats]
    crit_views = [cats[c] for c in crit]
    t_status = weakest(c["status"] for c in crit_views) if crit_views else "UNKNOWN"
    t_conf = float(np.prod([c["confidence"] for c in crit_views])) if crit_views else 0.0
    limiting = min(crit_views, key=lambda c: (STATUS_RANK[c["status"]], c["confidence"]))["name"] if crit_views else None
    for c in cats.values():
        c["critical"] = c["name"] in crit
        if c["critical"] and c["status"] in ("OUTDATED", "UNKNOWN"):
            pe.extra_warn.append(f"{_cap(data_is(c['label'], c['status']))} ({c['detail']}): "
                                 f"the ranges above are widened to cover it")
    deadline = ctx.req_deadline
    eta = pe.times(pe.cur)
    feas = {}
    for c, o in zip(CASES, pe.cur):
        if not math.isfinite(o):
            feas[c] = False
        elif deadline is None:
            feas[c] = True
        else:
            feas[c] = ctx.t0 + timedelta(seconds=o) <= deadline
    plan = {
        "id": spec.signature(), "kind": spec.kind, "lam": spec.lam, "labels": [],
        "modes": sorted({s["mode"] for s in pe.segments if s["mode"] != "wait"}),
        "title": _title(spec, pe), "eta": eta,
        "duration_min": {c: (round(o / 60, 1) if math.isfinite(o) else None) for c, o in zip(CASES, pe.cur)},
        "feasible": feas, "safety": {"lo": round(100 * (1 - r_hi)), "hi": round(100 * (1 - r_lo))},
        "risk": {c: {"lo": round(min(1, v["lo"] * mult), 3), "hi": round(min(1, v["hi"] * mult), 3)}
                 for c, v in comps.items()},
        "trust": {"status": t_status, "confidence": round(t_conf, 3), "limiting": limiting,
                  "overall": weakest(c["status"] for c in cats.values()) if cats else "UNKNOWN",
                  "categories": sorted(cats.values(), key=lambda c: (not c["critical"], STATUS_RANK[c["status"]]))},
        "segments": pe.segments, "distance_m": round(pe.dist_m), "walk_m": round(pe.walk_m),
        "outdoor_min": round(outdoor_min, 1), "warnings": list(pe.extra_warn), "safe_havens": pe.havens,
        "open_along": list(pe.along.values())[:6],
        "depends_on": crit, "_timing": pe.timing,
    }
    return plan


def _title(spec: RouteSpec, pe: PlanEval) -> str:
    if spec.kind == "walk":
        lab = pe.segments[0]["label"]
        return "Walk" + (" via " + lab.split(" via ", 1)[1] if " via " in lab else "")
    if spec.kind == "cab":
        return "Cab / auto" + (" (main roads)" if spec.lam > 0 else " (fastest roads)")
    leg = spec.legs[1]
    return f"{leg.route_id} {'bus' if spec.kind == 'bus' else 'metro'} from {leg.a[2]}"


# ---- selection ----------------------------------------------------------------------------------------
def _utility(p: dict, rw: float, eta_min: float, eta_max: float) -> float:
    e = p["duration_min"]["expected"] or 1e9
    span = max(eta_max - eta_min, 1.0)
    return rw * p["safety"]["lo"] / 100 + (1 - rw) * (1 - (e - eta_min) / span) * 0.6


def _feasible_pool(plans: list[dict]) -> tuple[list[dict], str]:
    for level in ("worst", "expected", "best"):
        pool = [p for p in plans if p["feasible"][level]]
        if pool:
            return pool, level
    return [], "none"


def plan(state, req: PlanRequest, cache: OpenCache, pinned: Optional[RouteSpec] = None) -> tuple[dict, dict]:
    ps, specs, _ = plan_full(state, req, cache, pinned)
    return ps, specs


def plan_full(state, req: PlanRequest, cache: OpenCache,
              pinned: Optional[RouteSpec] = None) -> tuple[dict, dict, list]:
    """Returns (plan set for the API, route spec per plan id, every evaluated plan)."""
    st = state.static
    now = state.now()
    night = (now.astimezone(st.tz) - timedelta(hours=12)).date()     # 02:00 belongs to the previous evening
    start_txt = req.start_time or req.finish_time
    requested = to_night(start_txt, night, st.tz) if start_txt else now
    departure = requested          # fixed: the re-planner pins "now" when a plan is created without a time
    ctx = Ctx(state, req, cache, departure)
    ctx.req_deadline = to_night(req.deadline, night, st.tz) if req.deadline else None
    if ctx.req_deadline is not None and ctx.req_deadline < requested - timedelta(hours=1):
        ctx.req_deadline += timedelta(days=1)
    phase = "before_departure" if now < departure else "in_progress"
    if phase == "in_progress":
        ctx.notes.append(f"Trip in progress since {hhmm(departure)} (assumed you left on time); "
                         f"re-evaluated with data as of {hhmm(now)}")
    modes = set(req.prefs.modes) | {"walk"}
    specs: list[RouteSpec] = []
    straight = float(np.hypot(ctx.oxy[0] - ctx.dxy[0], ctx.oxy[1] - ctx.dxy[1]))
    if straight < 40:
        ctx.warnings.append("Origin and destination are the same place")
    specs += walk_candidates(ctx)
    if "cab" in modes:
        specs += cab_candidates(ctx)
    for m in ("bus", "metro"):
        if m in modes or (m == "metro" and "bus" in modes):
            specs += transit_candidates(ctx, m)
    if pinned is not None:
        specs.insert(0, pinned)
    uniq: list[RouteSpec] = []
    for sp in specs:
        sp.signature()
        if any(sp.sig == u.sig or (sp.kind == u.kind and sp.kind in ("walk", "cab") and
                                   _overlap(sp, u, st) > ctx.cfg["dedupe_overlap"]) for u in uniq):
            continue
        uniq.append(sp)
    evaluated = [(sp, evaluate(ctx, sp)) for sp in uniq]
    plans, spec_by_id, invalid = [], {}, []
    for sp, p in evaluated:
        if p is None:
            continue
        if "invalid" in p:
            invalid.append(p)
            continue
        plans.append(p)
        spec_by_id[p["id"]] = sp
    for p in invalid:
        if p["kind"] in ("bus", "metro") and p["invalid"] not in ctx.notes:
            ctx.notes.append(p["invalid"])
    pinned_invalid = next((p["invalid"] for (sp, p) in evaluated[:1] if pinned is not None and p and "invalid" in p), None)

    rw = req.prefs.risk_weight
    max_walk = req.prefs.max_walk_m
    for p in plans:
        if p["walk_m"] > max_walk:
            p["warnings"].append(f"Walks {_m(p['walk_m'])}, more than your limit of {_m(max_walk)}")
    within = [p for p in plans if p["walk_m"] <= max_walk] or plans
    pool, level = _feasible_pool(within)
    no_feasible = not pool
    if no_feasible:
        pool = within
    warnings = list(ctx.warnings)
    if ctx.req_deadline is not None:
        if level == "expected":
            warnings.append("No plan is safe in the worst case before your deadline; showing plans that make it in the expected case.")
        elif level == "best":
            warnings.append("Only best-case timings reach your deadline: plan for being late.")
        elif no_feasible:
            warnings.append("No plan reaches your deadline even in the best case. Showing the closest alternatives.")
    out_plans: list[dict] = []
    rec = None
    if pool:
        etas = [p["duration_min"]["expected"] or 1e9 for p in pool]
        lo_e, hi_e = min(etas), max(etas)
        fastest = min(pool, key=lambda p: (p["duration_min"]["expected"] or 1e9, -p["safety"]["lo"]))
        safest = max(pool, key=lambda p: (p["safety"]["lo"], -(p["duration_min"]["expected"] or 1e9)))
        others = [p for p in pool if p is not fastest and p is not safest]
        balanced = max(others or pool, key=lambda p: _utility(p, 0.5, lo_e, hi_e))
        rec = max(pool, key=lambda p: _utility(p, rw, lo_e, hi_e))
        fastest["labels"].append("Fastest")
        safest["labels"].append("Safest")
        if balanced is not fastest and balanced is not safest:
            balanced["labels"].append("Balanced")
        rec["labels"].insert(0, "Recommended")
        for p in (rec, safest, fastest, balanced):
            if p not in out_plans:
                out_plans.append(p)
    plan_b = choose_plan_b(rec, plans) if rec else None
    if plan_b and plan_b["plan"] not in out_plans:
        out_plans.append(plan_b["plan"])
    if plan_b:
        plan_b["plan"]["labels"].append("Plan B")
    # show other modes too (clearly labelled) so the user sees what else exists and why it is worse
    shown_kinds = {p["kind"] for p in out_plans}
    for p in sorted(plans, key=lambda p: (-p["safety"]["lo"], p["duration_min"]["expected"] or 1e9)):
        if len(out_plans) >= 4:
            break
        if p not in out_plans and p["kind"] not in shown_kinds:
            p["labels"].append("Alternative")
            if not p["feasible"]["worst"] and ctx.req_deadline is not None:
                p["warnings"].insert(0, "May miss your deadline in the worst case")
            out_plans.append(p)
            shown_kinds.add(p["kind"])
    for p in out_plans:
        p["explanation"] = explain(ctx, p, plan_b if p is rec else None)
        p["leave_advice"] = leave_advice(ctx, p)
        p.pop("_timing", None)
    for p in plans:
        p.pop("_timing", None)
    havens = safe_havens_near(state, cache, departure, *ctx.oxy, 400, limit=3)
    if rec and rec["eta"]["worst"] and datetime.fromisoformat(rec["eta"]["worst"]) + timedelta(minutes=10) < now:
        phase = "arrived"
    t_route_0 = time.perf_counter()
    evaluated_routes, tie_info = evaluate_candidate_routes(ctx, plans, ctx.routing_cfg)
    t_route_ms = (time.perf_counter() - t_route_0) * 1000.0

    ps = {
        "phase": phase,
        "computed_at": now.isoformat(timespec="seconds"), "departure": departure.isoformat(timespec="seconds"),
        "requested_departure": requested.isoformat(timespec="seconds"),
        "deadline": ctx.req_deadline.isoformat(timespec="seconds") if ctx.req_deadline else None,
        "plans": out_plans, "recommended_id": rec["id"] if rec else None,
        "plan_b": {k: v for k, v in plan_b.items() if k != "plan"} | {"plan_id": plan_b["plan"]["id"]} if plan_b else None,
        "feasibility_level": level if not no_feasible else "none", "no_feasible": no_feasible,
        "warnings": warnings, "notes": ctx.notes, "alternatives_evaluated": len(plans),
        "pinned_invalid": pinned_invalid,
        "weather": ctx.er("walk", departure).weather.view.model_dump(),
        "closures": [{"id": c["id"], "name": c["name"], "reason": c["reason"], "kind": c["kind"], "lat": c["lat"],
                      "lon": c["lon"], "status": c["status"]} for c in ctx.er("walk", departure).closures],
        "havens_near_origin": havens,
        "timeline": timeline(ctx),
        "routes": evaluated_routes,
        "route_tie": tie_info.get("tie", False),
        "route_tie_note": tie_info.get("note"),
        "routing_time_ms": round(t_route_ms, 2),
    }
    for p in plans:
        p.setdefault("explanation", explain(ctx, p, None))
        p.setdefault("leave_advice", leave_advice(ctx, p))
    return ps, spec_by_id, plans


def choose_plan_b(rec: dict, plans: list[dict]) -> Optional[dict]:
    weak = rec["trust"]["limiting"]
    if weak is None:
        return None
    cands = [p for p in plans if p["id"] != rec["id"] and weak not in p["depends_on"]]
    if weak == "closures":                    # every plan depends on closures: pick a different mode
        cands = [p for p in plans if p["id"] != rec["id"] and p["kind"] != rec["kind"]]
    if not cands:
        cands = [p for p in plans if p["id"] != rec["id"] and p["kind"] != rec["kind"]]
    if not cands:
        return None
    best = max(cands, key=lambda p: (p["feasible"]["worst"], p["feasible"]["expected"], p["safety"]["lo"]))
    wc = next(c for c in rec["trust"]["categories"] if c["name"] == weak)
    trig = {
        "transit_timing": "if the bus has not arrived 5 minutes after its expected time",
        "cab_availability": "if no cab accepts within the upper wait estimate",
        "traffic": "if the cab is stuck in slow traffic",
        "closures": "if you meet a closure on the way",
        "weather": "if it starts raining heavily",
    }.get(weak, "if conditions change")
    return {"plan": best, "weak_link": weak, "weak_status": wc["status"],
            "reason": f"{_cap(data_is(CATEGORY_LABEL[weak], wc['status']))} ({wc['detail']})",
            "trigger": f"Switch to {best['title']} {trig}."}


def explain(ctx: Ctx, p: dict, plan_b: Optional[dict]) -> str:
    bits = []
    labels = [l for l in p["labels"] if l not in ("Recommended", "Plan B")]
    cats = {c["name"]: c for c in p["trust"]["categories"]}
    if "Safest" in labels:
        bits.append(f"highest worst-case safety ({p['safety']['lo']})")
    if "Fastest" in labels:
        bits.append(f"quickest expected arrival ({p['duration_min']['expected']:.0f} min)")
    if p["kind"] == "walk" and "lighting" in cats:
        bits.append(f"lighting: {cats['lighting']['detail']}")
    if p["kind"] in ("bus", "metro") and "transit_timing" in cats:
        bits.append(cats["transit_timing"]["detail"])
    if p["kind"] == "cab" and "cab_availability" in cats:
        bits.append(f"cab {cats['cab_availability']['detail']}")
    if p["safe_havens"]:
        bits.append(f"you can wait inside {p['safe_havens'][0]['name']}")
    if p.get("open_along"):
        first = p["open_along"][0]
        n = len(p["open_along"])
        bits.append(f"passes {n} open place{'s' if n > 1 else ''} on foot (e.g. {first['name']}, "
                    f"{first['cat']}, {first['open']['status']})")
    if "emergency" in cats and cats["emergency"]["status"] != "UNKNOWN":
        bits.append(cats["emergency"]["detail"])
    if not bits:
        bits.append(f"worst-case safety {p['safety']['lo']}, expected {p['duration_min']['expected']:.0f} min")
    text = ("Chosen because: " if "Recommended" in p["labels"] else "") + "; ".join(bits) + "."
    weak = [c for c in p["trust"]["categories"] if c["critical"] and c["status"] != "KNOWN"]
    if weak:
        w = weak[0]
        text += f" {_cap(data_is(w['label'], w['status']))}"
        if plan_b:
            text += f", so a Plan B ({plan_b['plan']['title']}) is included"
        text += "."
    return text[0].upper() + text[1:] if text else text


def leave_advice(ctx: Ctx, p: dict) -> Optional[str]:
    dl = ctx.req_deadline
    worst = p["eta"]["worst"]
    msgs = []
    if p["kind"] in ("bus", "metro"):
        walk_seg = p["segments"][0]
        wait_seg = next((s for s in p["segments"] if s["mode"] == "wait"), None)
        if walk_seg["end"]["worst"] and wait_seg and wait_seg["end"]["expected"]:
            tw = datetime.fromisoformat(walk_seg["end"]["worst"])
            board = datetime.fromisoformat(wait_seg["end"]["expected"])
            slack = (board - tw).total_seconds() - 60
            if slack < 0:
                msgs.append(f"Leave {math.ceil(-slack / 60)} min earlier to be sure of catching the "
                            f"{hhmm(board)} bus (timing {wait_seg['facts'][0]['status']}).")
    if dl is not None:
        if worst:
            w = datetime.fromisoformat(worst)
            dur = w - ctx.t0
            latest = dl - dur
            if latest >= ctx.t0 + timedelta(minutes=3):
                msgs.append(f"Leave by {hhmm(latest)} to arrive by {hhmm(dl)} even in the worst case.")
            elif latest >= ctx.t0:
                msgs.append(f"Leave now: only {int((latest - ctx.t0).total_seconds() // 60)} min of worst-case buffer.")
            else:
                late = int((w - dl).total_seconds() // 60)
                msgs.append(f"Worst case arrives {late} min after your deadline; leave {late} min earlier "
                            f"or tell your contact you may be late.")
        else:
            msgs.append("The worst case has no catchable connection: keep Plan B ready.")
    return " ".join(msgs) or None


def timeline(ctx: Ctx) -> dict:
    st, tn = ctx.st, ctx.st.transit
    items = []
    if tn:
        near = {s[0] for s in tn.stops_near(*ctx.oxy, 1500)} | {s[0] for s in tn.stops_near(*ctx.dxy, 1500)}
        for rid in sorted(near):
            r = tn.routes[rid]
            items.append({"route": rid, "name": r.name, "mode": r.mode, "color": r.color, "note": r.note,
                          "windows": [[a.isoformat(timespec="minutes"), b.isoformat(timespec="minutes")]
                                      for a, b in tn.service_windows(rid)],
                          "status": "PROBABLE" if ctx.state.available("transit_schedule") else "UNKNOWN"})
    return {"routes": items}

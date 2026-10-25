"""Events that change the simulator's ground truth or the sources (used by the
Simulation drawer and by scenario files). The planner only learns about them
through feeds, never directly."""
from __future__ import annotations

from datetime import timedelta
from typing import Optional

import numpy as np

from ...adapters.osm import MAIN_ROADS
from ..state import WorldState

LIVE = ("traffic_live", "transit_realtime", "weather_live", "closures_feed", "cab_availability",
        "incident_reports")


def set_source(state: WorldState, source: str, enabled: bool) -> list[str]:
    ids = list(LIVE) if source == "all_live" else (
        [k for k in state.sources if k != "osm_map"] if source == "all" else [source])
    changed = []
    for sid in ids:
        src = state.sources.get(sid)
        if src is None or sid == "osm_map":
            continue
        if src.enabled != enabled:
            src.enabled = enabled
            changed.append(sid)
    if changed:
        verb = "restored" if enabled else "OUTAGE"
        labels = ", ".join(state.sources[c].label for c in changed)
        state.log_event("outage" if not enabled else "restore", f"{verb}: {labels}",
                        "info" if enabled else "warn")
    return changed


def _closure_edges(state: WorldState, lat: float, lon: float, radius: float = 350.0,
                   name: Optional[str] = None) -> tuple[list[int], list[int], str]:
    st = state.static
    x, y = st.proj.xy(lat, lon)
    out = {}
    for which, G in (("walk", st.walk), ("drive", st.drive)):
        d = np.hypot(G.emx - x, G.emy - y)
        if name is None:
            near = np.argsort(d)[:30]
            main = [e for e in near if G.ehw[e] in MAIN_ROADS and G.ename[e]]
            pick = main[0] if main else int(near[0])
            name = G.ename[pick] if G.ename[pick] else None
        if name:
            sel = [int(e) for e in np.nonzero((d < radius))[0] if G.ename[e] == name]
        else:
            sel = [int(e) for e in np.nonzero(d < 60)[0]]
        out[which] = sel
    return out["walk"], out["drive"], name or "unnamed road"


def add_closure(state: WorldState, lat: float, lon: float, reason: str = "road closed (police barricade)",
                kind: str = "closure", name: Optional[str] = None, radius: float = 350.0) -> dict:
    walk_e, drive_e, nm = _closure_edges(state, lat, lon, radius, name)
    cid = state.next_id("cl")
    c = {"name": nm, "reason": reason, "kind": kind, "walk_edges": walk_e, "drive_edges": drive_e,
         "lat": lat, "lon": lon, "since": state.now()}
    state.truth.closures[cid] = c
    if kind == "accident":
        st = state.static
        x, y = st.proj.xy(lat, lon)
        state.truth.accidents[int(st.tgrid.index(x, y))] = 0.35
    state.log_event("event", f"[truth] {kind} on {nm}: {reason} ({len(drive_e)} road segments)", "warn")
    return {"id": cid, **{k: v for k, v in c.items() if k != "since"}}


def lift_closure(state: WorldState, cid: str) -> bool:
    c = state.truth.closures.pop(cid, None)
    if c is None:
        return False
    state.truth.lifted[cid] = (state.now(), c)
    state.log_event("event", f"[truth] closure lifted on {c['name']}")
    return True


def main_road_on_route(state: WorldState, legs: list) -> Optional[tuple[float, float, str]]:
    """Pick the longest named main road the given route uses (for scenario closures)."""
    st = state.static
    best: dict[str, tuple[float, int, str]] = {}
    for leg in legs:
        G = st.walk if leg.graph == "walk" else st.drive if leg.graph == "drive" else None
        if G is None:
            continue
        for e, _ in leg.edges:
            nm = G.ename[e]
            if nm and G.ehw[e] in MAIN_ROADS:
                L = best.get(nm, (0.0, e, leg.graph))[0] + float(G.elen[e])
                best[nm] = (L, e, leg.graph)
    if not best:
        return None
    nm, (_, e, g) = max(best.items(), key=lambda kv: kv[1][0])
    G = st.walk if g == "walk" else st.drive
    return float(G.emlat[e]), float(G.emlon[e]), nm


def set_rain(state: WorldState, intensity: Optional[str]) -> None:
    tr = state.truth
    tr.rain = None if intensity in (None, "none", "stop") else intensity
    tr.rain_since = state.now() if tr.rain else None
    state.log_event("event", f"[truth] rain {'stopped' if tr.rain is None else 'started: ' + tr.rain}",
                    "warn" if tr.rain else "info")


def add_incident(state: WorldState, lat: float, lon: float, kind: str = "harassment", severity: float = 0.8) -> dict:
    inc = {"id": state.next_id("inc"), "lat": lat, "lon": lon, "t": state.now(), "type": kind, "severity": severity}
    state.truth.incidents.append(inc)
    state.log_event("event", f"[truth] incident reported: {kind} (severity {severity:.1f})", "warn")
    return {k: v for k, v in inc.items() if k != "t"}


def cancel_route(state: WorldState, route_id: str, from_time=None) -> None:
    t = from_time or state.now()
    state.truth.cancel_route_from[route_id] = t
    state.log_event("event", f"[truth] {route_id} trips from {t.strftime('%H:%M')} cancelled", "warn")


def cancel_next_trip(state: WorldState, route_id: str, trip_id: Optional[str] = None) -> Optional[str]:
    """Cancel the given trip (or the next one on the route) and the one after it in the same direction."""
    st = state.static
    if not st.transit:
        return None
    now = state.now()
    first = st.transit.trips.get(trip_id) if trip_id else None
    pool = sorted((t for t in st.transit.trips.values() if t.route_id == route_id
                   and (first is None or t.direction == first.direction)
                   and t.start >= (first.start if first else now - timedelta(minutes=20))), key=lambda t: t.start)
    if not pool:
        return None
    for t in pool[:2]:
        state.truth.cancelled_trips.add(t.id)
    state.log_event("event", f"[truth] {route_id}: trips from {pool[0].start.strftime('%H:%M')} cancelled", "warn")
    return pool[0].id


def plan_context(ap) -> dict:
    """What an injected event may target: the active plan's route, roads and trip."""
    ctx = {"near": (ap.request.origin.lat, ap.request.origin.lon)}
    if ap.pinned is not None:
        ctx["legs"] = ap.pinned.legs
        rid = next((l.route_id for l in ap.pinned.legs if l.route_id), None)
        if rid:
            ctx["route"] = rid
    ps = ap.planset or {}
    rec = next((p for p in ps.get("plans", []) if p["id"] == ps.get("recommended_id")), None)
    if rec:
        trip = next((s.get("trip_id") for s in rec["segments"] if s.get("trip_id")), None)
        if trip:
            ctx["trip"] = trip
            ctx.setdefault("route", trip.split("-")[0])
    return ctx


def schedule_conflict(state: WorldState, route_id: str, delay_s: float = 900) -> None:
    state.truth.schedule_conflicts[route_id] = delay_s
    state.log_event("event", f"[truth] {route_id} actually running {int(delay_s // 60)} min behind its timetable",
                    "warn")


def apply(state: WorldState, ev: dict, context: Optional[dict] = None) -> dict:
    """Apply one scenario / UI event: {"type": ..., "params": {...}}."""
    t = ev.get("type")
    p = ev.get("params", {}) or {}
    ctx = context or {}
    if t == "source_outage":
        return {"changed": set_source(state, p.get("source", "all_live"), False)}
    if t == "source_restore":
        return {"changed": set_source(state, p.get("source", "all_live"), True)}
    if t == "rain_start":
        set_rain(state, p.get("intensity", "heavy"))
        return {}
    if t == "rain_stop":
        set_rain(state, None)
        return {}
    if t == "fog":
        state.truth.fog = bool(p.get("on", True))
        state.log_event("event", f"[truth] fog {'rolled in' if state.truth.fog else 'cleared'}")
        return {}
    if t in ("road_closure", "accident"):
        lat, lon, name = p.get("lat"), p.get("lon"), p.get("name")
        if p.get("edge_selector") == "main_road_nearest_route" and ctx.get("legs"):
            hit = main_road_on_route(state, ctx["legs"])
            if hit:
                lat, lon, name = hit
        if lat is None:
            lat, lon = state.static.center
        return add_closure(state, lat, lon, p.get("reason", "road closed" if t == "road_closure" else "accident"),
                           kind="closure" if t == "road_closure" else "accident", name=name)
    if t == "lift_closure":
        return {"ok": lift_closure(state, p["id"])}
    if t == "incident":
        lat, lon = p.get("lat"), p.get("lon")
        if lat is None:
            lat, lon = ctx.get("near", state.static.center)
        return add_incident(state, lat, lon, p.get("kind", "harassment"), float(p.get("severity", 0.8)))
    if t == "bus_cancelled":
        rid = p.get("route") or ctx.get("route")
        if not rid:
            return {"error": "no bus route in the current plan: pass params.route"}
        if p.get("all"):
            cancel_route(state, rid)
            return {"route": rid}
        trip = None if p.get("route") else ctx.get("trip")
        return {"trip": cancel_next_trip(state, rid, trip)}
    if t == "schedule_conflict":
        rid = p.get("route") or ctx.get("route")
        if rid:
            schedule_conflict(state, rid, float(p.get("delay_s", 900)))
        return {"route": rid}
    if t == "cab_shortage":
        state.truth.cab_multiplier = float(p.get("multiplier", 2.5))
        state.log_event("event", f"[truth] cab shortage (waits x{state.truth.cab_multiplier:.1f})", "warn")
        return {}
    return {"error": f"unknown event type {t}"}

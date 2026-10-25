"""HTTP API. Every fact that leaves here is a FactView-shaped dict
({value, status, confidence, source, age_s, synthetic}) and every synthetic
input is flagged."""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..core import heatmap as heatmap_mod
from ..core import needs, nlp, planner
from ..core.clock import to_night
from ..core.services import open_fact
from ..core.sim import events, scenarios
from ..core.validate import validate_planset
from ..presentation import simple_view

router = APIRouter(prefix="/api")
ENGINE = {"engine": None, "error": None, "scenario_results": None}


def eng():
    e = ENGINE["engine"]
    if e is None:
        raise HTTPException(503, ENGINE["error"] or "engine not ready")
    return e


def _json(obj) -> str:
    return json.dumps(obj, default=str, separators=(",", ":"))


# ---- meta ---------------------------------------------------------------------------------
@router.get("/health")
def health():
    e = ENGINE["engine"]
    if e is None:
        return {"ok": False, "error": ENGINE["error"]}
    st = e.static
    ver = hashlib.sha1(f"{st.map_generated_at}|{st.pois_generated_at}|{st.weather.fetched_at}|"
                       f"{st.transit.generated_at if st.transit else None}".encode()).hexdigest()[:10]
    return {"ok": True, "city": st.cfg["city_name"], "data_version": ver, "sim_time": e.state.now().isoformat(),
            "active_plans": len(e.replanner.plans)}


@router.get("/config")
def config():
    e = eng()
    st = e.static
    import os
    return {"city_name": st.cfg["city_name"], "center": {"lat": st.center[0], "lon": st.center[1]},
            "radius_m": st.radius, "timezone": str(st.tz), "night": st.night.isoformat(),
            "personas": st.personas, "weights": st.risk_cfg["weights"], "llm_enabled": bool(os.environ.get("GROQ_API_KEY")),
            "credits": ["© OpenStreetMap contributors (ODbL)", "Weather data by Open-Meteo.com (CC BY 4.0)"],
            "synthetic_sources": [k for k, v in st.source_cfg.items() if v["synthetic"]],
            "needs": list(needs.NEEDS), "ui_defaults": ui_defaults(e)}


def ui_defaults(e) -> dict:
    """Pre-filled Home / Work / start point for the simple UI (demo persona from config.yaml)."""
    st = e.static
    d = st.cfg.get("presentation", {}).get("ui_defaults", {})
    per = next((p for p in st.personas if p["id"] == d.get("persona")), st.personas[0] if st.personas else None)
    if per is None:
        c = {"lat": st.center[0], "lon": st.center[1], "name": st.cfg["city_name"]}
        return {"home": c, "work": c, "start": c, "deadline": d.get("deadline")}
    return {"home": {**per["home_point"], "name": per["home_point"]["name"]},
            "work": {**per["origin_point"]}, "start": {**per["origin_point"]}, "deadline": d.get("deadline")}


def _present(e, ap, lang: Optional[str] = None) -> dict:
    """The simple, plain-language view (UI_SPEC §4) with the technical plan set under `details`."""
    return simple_view.present(ap.planset, lang=lang or ap.request.lang, now=e.state.now(), cfg=e.static.cfg,
                               connection=simple_view.connection_state(e.state),
                               dest=ap.request.destination.model_dump())


def _get_ap(e, pid: str):
    ap = e.replanner.plans.get(pid) or e.replanner.parked.get(pid)
    if ap is None:
        raise HTTPException(404, "plan not found (expired?)")
    if pid in e.replanner.parked:            # a shared link revives a parked plan
        e.replanner.plans[pid] = e.replanner.parked.pop(pid)
    ap.last_access = time.monotonic()
    return ap


@router.get("/status")
def status(lang: str = "en"):
    """Live / Offline for the status pill, plus the sim time."""
    e = eng()
    return {"connection": simple_view.connection_state(e.state), "now": e.state.now().isoformat(timespec="seconds"),
            "now_text": simple_view.clock(e.state.now().isoformat())}


# ---- planning ------------------------------------------------------------------------------
@router.post("/plan")
def create_plan(req: planner.PlanRequest):
    e = eng()
    st = e.static
    for p in (req.origin, req.destination):
        if not st.in_area(p.lat, p.lon):
            raise HTTPException(400, f"({p.lat:.4f}, {p.lon:.4f}) is outside the demo area ({st.cfg['city_name']})")
    with e.state.lock:
        ap = e.replanner.create(req)
        if e.autostart:                      # demo clock starts with the first planned trip
            e.autostart = False
            e.clock.set(paused=False)
            e._last = e.clock.now()
        return _present(e, ap)


@router.get("/plan/{pid}")
def get_plan(pid: str, lang: Optional[str] = None):
    e = eng()
    ap = _get_ap(e, pid)
    with e.state.lock:
        return _present(e, ap, lang)


class ChooseBody(BaseModel):
    plan_id: str
    lang: Optional[str] = None


@router.post("/plan/{pid}/choose")
def choose_plan(pid: str, body: ChooseBody):
    """The user tapped Start: follow this way from now on (only left if it breaks or gets late)."""
    e = eng()
    ap = _get_ap(e, pid)
    with e.state.lock:
        if not e.replanner.choose(ap, body.plan_id):
            raise HTTPException(404, "that way is no longer available")
        return _present(e, ap, body.lang)


@router.delete("/plan/{pid}")
def drop_plan(pid: str):
    eng().replanner.plans.pop(pid, None)
    return {"ok": True}


@router.get("/plan/{pid}/stream")
async def stream_plan(pid: str, request: Request, lang: Optional[str] = None):
    e = eng()
    if pid in e.replanner.parked:
        e.replanner.plans[pid] = e.replanner.parked.pop(pid)
    if pid not in e.replanner.plans:
        raise HTTPException(404, "plan not found")
    e.replanner.plans[pid].last_access = time.monotonic()

    async def gen():
        last, idle = -1, 0
        while True:
            if await request.is_disconnected():
                break
            ap = eng().replanner.plans.get(pid)
            if ap is None:
                yield "event: gone\ndata: {}\n\n"
                break
            ap.last_access = time.monotonic()
            if ap.version != last:
                last = ap.version
                with e.state.lock:
                    payload = _json(_present(e, ap, lang))
                yield f"event: plan_update\ndata: {payload}\n\n"
                idle = 0
            else:
                idle += 1
                if idle % 30 == 0:
                    yield ": ping\n\n"
            await asyncio.sleep(0.5)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class NLBody(BaseModel):
    text: str


@router.post("/nl/parse")
def nl_parse(body: NLBody):
    e = eng()
    return nlp.parse(body.text, geocode=lambda q: e.static.geocode(q, 5))


@router.get("/geocode")
def geocode(q: str, limit: int = 8):
    return eng().static.geocode(q, limit)


@router.get("/where")
def where(lat: float, lon: float, lang: str = "en"):
    """Plain name for a point tapped on the map: 'Near Atta Market' (never raw coordinates)."""
    name = eng().static.nearest_place_name(lat, lon)
    t = simple_view.T(lang)
    return {"name": t("fmt.near", place=simple_view.short_place(name)) if name else t("label.pickedPoint")}


# ---- trust & simulation ------------------------------------------------------------------
@router.get("/trust")
def trust():
    e = eng()
    with e.state.lock:
        return e.trust()


class OutageBody(BaseModel):
    source: str
    enabled: bool


@router.post("/sim/outage")
def outage(body: OutageBody):
    e = eng()
    if body.source not in e.state.sources and body.source not in ("all", "all_live"):
        raise HTTPException(400, f"unknown source {body.source}")
    with e.state.lock:
        changed = events.set_source(e.state, body.source, body.enabled)
        e.state.record_source_history()
    return {"changed": changed, "sources": {k: v.enabled for k, v in e.state.sources.items()}}


class ClockBody(BaseModel):
    speed: Optional[float] = None
    paused: Optional[bool] = None
    time: Optional[str] = None
    advance_s: Optional[float] = None


@router.post("/sim/clock")
def sim_clock(body: ClockBody):
    e = eng()
    with e.state.lock:
        if body.advance_s:
            e.advance(min(body.advance_s, 4 * 3600))
        if body.time:
            t = to_night(body.time, e.static.night, e.static.tz)
            e.clock.set(time_=t)
            e._last = e.clock.now()
        if body.speed is not None or body.paused is not None:
            e.clock.set(speed=body.speed, paused=body.paused)
            e.autostart = False
            e._last = e.clock.now()
    return e.sim_state()


@router.get("/sim/state")
def sim_state():
    return eng().sim_state()


class InjectBody(BaseModel):
    type: str
    params: dict = {}
    plan_id: Optional[str] = None


@router.post("/sim/inject")
def inject(body: InjectBody):
    e = eng()
    ap = e.replanner.plans.get(body.plan_id) if body.plan_id else None
    ctx = events.plan_context(ap) if ap is not None else {}
    with e.state.lock:
        res = events.apply(e.state, {"type": body.type, "params": body.params}, ctx)
    if "error" in res:
        raise HTTPException(400, res["error"])
    return res


@router.post("/sim/reset")
def reset():
    e = eng()
    with e.state.lock:
        e.reset()
        e._heat_cache = {}
    return e.sim_state()


@router.get("/scenarios")
def list_scenarios():
    return [{"id": s["id"], "name": s.get("name", s["id"]), "description": s.get("description", ""),
             "events": s.get("events", []), "expect": s.get("expect", {})} for s in scenarios.load_all()]


@router.post("/sim/scenario/{sid}/run")
def run_scenario(sid: str):
    e = eng()
    sc = next((s for s in scenarios.load_all() if s["id"] == sid), None)
    if sc is None:
        raise HTTPException(404, "unknown scenario")
    res = scenarios.run(e.static, sc)
    prev = {r["id"]: r for r in (ENGINE["scenario_results"] or {}).get("results", [])}
    prev[sid] = res
    ENGINE["scenario_results"] = {"ran_at": datetime.now().isoformat(timespec="seconds"),
                                  "results": list(prev.values())}
    return res


@router.post("/scenarios/run_all")
def run_all():
    e = eng()
    res = [scenarios.run(e.static, sc) for sc in scenarios.load_all()]
    ENGINE["scenario_results"] = {"ran_at": datetime.now().isoformat(timespec="seconds"), "results": res}
    return ENGINE["scenario_results"]


@router.get("/scenarios/results")
def scenario_results():
    return ENGINE["scenario_results"] or {"ran_at": None, "results": []}


# ---- services --------------------------------------------------------------------------------
@router.get("/need-now")
def need_now(type: str, lat: float, lon: float, time: Optional[str] = None, lang: str = "en"):  # noqa: A002
    e = eng()
    t = to_night(time, e.static.night, e.static.tz) if time else None
    with e.state.lock:
        try:
            res = needs.need_now(e, type, lat, lon, t, limit=5)
        except ValueError as ex:
            raise HTTPException(400, str(ex))
    places = simple_view.simple_places(res["results"], lang)
    if res.get("fallback"):
        places += [p for p in simple_view.simple_places([res["fallback"]], lang) if p["id"] not in {q["id"] for q in places}]
    return {**res, "places": places[:5],
            "empty_text": simple_view.T(lang)("line.nothingOpen") if not places else None}


class SOSBody(BaseModel):
    lat: float
    lon: float
    lang: str = "en"


@router.post("/sos")
def sos(body: SOSBody):
    e = eng()
    with e.state.lock:
        res = needs.sos(e, body.lat, body.lon)
    return {**res, "hospital": (simple_view.simple_places(res["nearest_hospitals"], body.lang) or [None])[0],
            "police": (simple_view.simple_places(res["nearest_police"], body.lang) or [None])[0]}


class ShareBody(BaseModel):
    plan_id: str
    contact: Optional[str] = None


@router.post("/share")
def share(body: ShareBody):
    ap = eng().replanner.plans.get(body.plan_id)
    if ap is None:
        raise HTTPException(404, "plan not found")
    rec = next((p for p in ap.planset["plans"] if p["id"] == ap.planset["recommended_id"]), None)
    token = hashlib.sha1(f"{body.plan_id}{time.time()}".encode()).hexdigest()[:8]
    return {"simulated": True, "url": f"/?trip={body.plan_id}&share={token}",
            "contact": body.contact or "Trusted contact (simulated)",
            "summary": (f"{rec['title']}, arriving {rec['eta']['best'][11:16]}-{(rec['eta']['worst'] or '?')[11:16]}"
                        f" (data {rec['trust']['status']})") if rec else "no plan",
            "message": "Simulation only: nothing was sent. A real build would push live updates to this contact."}


@router.get("/heatmap")
def heatmap(hour: int = 2):
    e = eng()
    with e.state.lock:
        return heatmap_mod.heatmap(e, hour)


# ---- map layers ---------------------------------------------------------------------------------
_STREETS: dict = {}


@router.get("/map/streets")
def streets(main: bool = False):
    """Street lines from the cached graph (the offline base map). `main=1`: main roads only (small)."""
    e = eng()
    key = "main" if main else "walk"
    if key not in _STREETS:
        G, S = e.static.walk, e.static.walk_static
        idx = [i for i in range(G.m) if G.is_main[i]] if main else range(G.m)
        feats = [{"type": "Feature", "geometry": {"type": "LineString", "coordinates": G.egeom[i]},
                  "properties": {"hw": G.ehw[i], "main": bool(G.is_main[i]), "light": int(S.light_code[i]),
                                 "name": G.ename[i]}} for i in idx]
        _STREETS[key] = {"type": "FeatureCollection", "features": feats}
    return _STREETS[key]


@router.get("/map/pois")
def pois(time: Optional[str] = None):  # noqa: A002
    e = eng()
    s = e.state
    t = to_night(time, e.static.night, e.static.tz) if time else s.now()
    feats = []
    with s.lock:
        for p in e.static.facilities:
            v = s.view(open_fact(s, p, t))
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [p.lon, p.lat]},
                          "properties": {"id": p.id, "name": p.label, "cat": p.cat, "status": v.status,
                                         "open": v.value, "confidence": v.confidence, "note": v.note,
                                         "source": v.source}})
    lamps = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [p.lon, p.lat]},
              "properties": {"cat": "street_lamp"}} for p in e.static.pois if p.cat == "street_lamp"]
    return {"type": "FeatureCollection", "features": feats + lamps, "time": t.isoformat(timespec="minutes")}


@router.get("/map/transit")
def transit():
    e = eng()
    tn = e.static.transit
    if tn is None:
        return {"type": "FeatureCollection", "features": [], "synthetic": True}
    feats = []
    for r in tn.routes.values():
        coords = r.shape or [[s.lon, s.lat] for s in r.stops]
        feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
                      "properties": {"route": r.id, "name": r.name, "mode": r.mode, "color": r.color, "note": r.note}})
        for s in r.stops:
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [s.lon, s.lat]},
                          "properties": {"route": r.id, "name": s.name, "mode": r.mode, "color": r.color,
                                         "stop": True}})
    return {"type": "FeatureCollection", "features": feats, "synthetic": tn.synthetic, "source": tn.source_note}


@router.post("/weather/refresh")
def weather_refresh():
    e = eng()
    st = e.static
    ok = st.weather.refresh(st.center[0], st.center[1], st.cfg["user_agent"])
    return {"ok": ok, "fetched_at": st.weather.fetched_at.isoformat() if st.weather.fetched_at else None,
            "message": "refreshed from Open-Meteo" if ok else "offline or Open-Meteo unavailable: kept cached forecast"}


@router.get("/validate/{pid}")
def validate(pid: str):
    ap = eng().replanner.plans.get(pid)
    if ap is None:
        raise HTTPException(404, "plan not found")
    v = validate_planset(json.loads(_json(ap.planset)))
    return {"ok": not v, "violations": v}

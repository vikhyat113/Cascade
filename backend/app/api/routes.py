"""HTTP API. Every fact that leaves here is a FactView-shaped dict
({value, status, confidence, source, age_s, synthetic}) and every synthetic
input is flagged."""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import time
from datetime import datetime, timezone
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
    import math
    import os
    res = {"city_name": st.cfg["city_name"], "center": {"lat": st.center[0], "lon": st.center[1]},
           "radius_m": st.radius, "timezone": str(st.tz), "night": st.night.isoformat(),
           "personas": st.personas, "weights": st.risk_cfg["weights"], "llm_enabled": bool(os.environ.get("GROQ_API_KEY")),
           "credits": ["© OpenStreetMap contributors (ODbL)", "Weather data by Open-Meteo.com (CC BY 4.0)"],
           "synthetic_sources": [k for k, v in st.source_cfg.items() if v["synthetic"]],
           "needs": list(needs.NEEDS), "ui_defaults": ui_defaults(e)}
    if st.area is not None:
        res["area_mode"] = "polygon"
        res["area_source"] = f"{st.area.source_path} ({st.area.source_mtime})"
        res["vertex_count"] = len(st.area.polygon.exterior.coords)
        res["area_km2"] = round(st.area.area_km2(), 2)
        res["bbox"] = st.area.bbox
        res["placeholder_suspect"] = bool(st.area.placeholder_suspect)
        res["polygon"] = st.area.geojson_geometry
    else:
        deg_lat = st.radius / 110540.0
        deg_lon = st.radius / (111320.0 * math.cos(math.radians(st.center[0])))
        circ_area = math.pi * (st.radius / 1000.0) ** 2
        res["area_mode"] = "circle_fallback"
        res["area_source"] = "config.yaml (center + radius_m)"
        res["vertex_count"] = 0
        res["area_km2"] = round(circ_area, 2)
        res["bbox"] = [round(st.center[1] - deg_lon, 6), round(st.center[0] - deg_lat, 6),
                       round(st.center[1] + deg_lon, 6), round(st.center[0] + deg_lat, 6)]
        res["placeholder_suspect"] = False
        res["polygon"] = None
    return res


@router.get("/area/diagnostics")
def area_diagnostics():
    e = eng()
    st = e.static
    cfg_data = config()

    walk_n, walk_m = int(st.walk.n), int(st.walk.m)
    drive_n, drive_m = int(st.drive.n), int(st.drive.m)

    if st.area is not None:
        walk_inside = sum(1 for la, lo in zip(st.walk.lat, st.walk.lon) if st.area.contains_buffered(la, lo))
        drive_inside = sum(1 for la, lo in zip(st.drive.lat, st.drive.lon) if st.area.contains_buffered(la, lo))
        total_nodes = walk_n + drive_n
        total_inside = walk_inside + drive_inside
        share_nodes_inside = round(100.0 * total_inside / max(1, total_nodes), 2)

        pois_inside = sum(1 for p in st.pois if st.area.contains(p.lat, p.lon))
        pois_outside = len(st.pois) - pois_inside

        source_mtime_str = st.area.source_mtime
        def _to_utc(s: str) -> Optional[datetime]:
            if not s:
                return None
            try:
                dt = datetime.fromisoformat(s)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.astimezone(timezone.utc)
            except Exception:
                return None

        source_dt = _to_utc(source_mtime_str) or datetime.now(timezone.utc)
        walk_gen = str(st.walk.generated_at or "")
        pois_gen = st.pois_generated_at.isoformat() if st.pois_generated_at else ""

        stale_data = False
        w_dt = _to_utc(walk_gen)
        if w_dt and w_dt < source_dt:
            stale_data = True
        p_dt = _to_utc(pois_gen)
        if p_dt and p_dt < source_dt:
            stale_data = True
    else:
        walk_inside = walk_n
        drive_inside = drive_n
        share_nodes_inside = 100.0
        pois_inside = len(st.pois)
        pois_outside = 0
        source_mtime_str = ""
        walk_gen = str(st.walk.generated_at or "")
        pois_gen = st.pois_generated_at.isoformat() if st.pois_generated_at else ""
        stale_data = False

    return {
        "area_mode": cfg_data["area_mode"],
        "area_source": cfg_data["area_source"],
        "source_mtime": source_mtime_str,
        "vertex_count": cfg_data["vertex_count"],
        "area_km2": cfg_data["area_km2"],
        "bbox": cfg_data["bbox"],
        "placeholder_suspect": cfg_data["placeholder_suspect"],
        "walk_nodes": walk_n,
        "walk_edges": walk_m,
        "drive_nodes": drive_n,
        "drive_edges": drive_m,
        "walk_nodes_inside": walk_inside,
        "drive_nodes_inside": drive_inside,
        "share_nodes_inside": share_nodes_inside,
        "pois_inside": pois_inside,
        "pois_outside": pois_outside,
        "walk_generated_at": walk_gen,
        "pois_generated_at": pois_gen,
        "stale_data": stale_data,
    }


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


def _poi_category_group(cat: str, tags: dict) -> Optional[str]:
    s = tags.get("shop", "")
    hc = tags.get("healthcare", "")
    a = tags.get("amenity", "")
    if cat in ("pharmacy", "chemist") or hc == "pharmacy" or s == "chemist":
        return "medicine"
    if cat in ("food", "food_court", "bakery", "shop") or a in ("restaurant", "fast_food", "cafe", "food_court") or s in ("convenience", "supermarket", "kiosk", "bakery"):
        return "food"
    if cat in ("hospital", "clinic", "doctors") or a in ("hospital", "clinic", "doctors") or hc in ("hospital", "clinic"):
        return "hospital"
    if cat == "police" or a == "police":
        return "police"
    return None


@router.get("/map/pois")
def pois(time: Optional[str] = None):  # noqa: A002
    e = eng()
    s = e.state
    t = to_night(time, e.static.night, e.static.tz) if time else s.now()
    feats = []
    with s.lock:
        for p in e.static.facilities:
            v = s.view(open_fact(s, p, t))
            tier = "unknown"
            if v.value is False:
                tier = "closed"
            elif v.status == "KNOWN" and v.value is True:
                tier = "open"
            elif v.status == "PROBABLE" and v.value is True:
                tier = "maybe_open"

            group = _poi_category_group(p.cat, p.tags)
            raw_oh = p.tags.get("opening_hours") or ""
            is_24h = bool(raw_oh.strip().lower() == "24/7" or p.cat == "police" or p.tags.get("emergency") == "yes")
            edited = p.edited_at.isoformat() if p.edited_at else None

            feats.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [p.lon, p.lat]},
                "properties": {
                    "id": p.id,
                    "name": p.label,
                    "cat": p.cat,
                    "category_group": group,
                    "group": group,
                    "status": v.status,
                    "open": v.value,
                    "tier": tier,
                    "hours_state": {
                        "tier": tier,
                        "open": v.value,
                        "status": v.status,
                        "text": raw_oh,
                        "note": v.note,
                    },
                    "confidence": v.confidence,
                    "note": v.note,
                    "source": v.source,
                    "edited_at": edited,
                    "last_osm_edit": edited,
                    "is_24h": is_24h,
                }
            })
    lamps = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [p.lon, p.lat]},
              "properties": {"cat": "street_lamp"}} for p in e.static.pois if p.cat == "street_lamp"]
    return {"type": "FeatureCollection", "features": feats + lamps, "time": t.isoformat(timespec="minutes")}


@router.get("/layers")
def list_layers():
    e = eng()
    s = e.state
    st = e.static
    layers_meta = []

    # 1. VIIRS Night Lights
    v_src = s.sources.get("viirs_ntl")
    v_view = s.source_view("viirs_ntl") if v_src else None
    v_data = getattr(st, "viirs_data", None)
    v_cells = v_data.get("rows", []) if v_data else []
    v_unknown = sum(1 for r in v_cells if r.get("radiance") is None or r.get("status_hint") == "UNKNOWN") if v_cells else 0
    layers_meta.append({
        "id": "viirs_ntl",
        "name": "Night lights (VIIRS)",
        "source": v_data.get("source") if v_data else "NASA Black Marble (VNP46) / Suomi NPP VIIRS DNB",
        "product": v_data.get("product") if v_data else "VIIRS_Black_Marble",
        "date_range": v_data.get("acquired_range") if v_data else None,
        "retrieved_at": v_data.get("retrieved_at") if v_data else None,
        "native_resolution": v_data.get("native_resolution", "15 arc-seconds (~500 m)") if v_data else "15 arc-seconds (~500 m)",
        "units": v_data.get("unit", "nW·cm⁻²·sr⁻¹") if v_data else "nW·cm⁻²·sr⁻¹",
        "license": v_data.get("license") if v_data else "NASA Open Data Policy / Public Domain",
        "attribution": v_data.get("attribution") if v_data else "NASA EOSDIS / Black Marble Science Team",
        "status": v_view.status if v_view else "UNKNOWN",
        "confidence": v_view.confidence if v_view else 0.0,
        "age_s": v_view.age_s if v_view else None,
        "available": bool(v_data and v_src and v_src.enabled),
        "cell_count": len(v_cells),
        "unknown_share": round((v_unknown / max(1, len(v_cells))) * 100, 1),
        "synthetic": False,
        "note": "Blocky 500m cells showing nighttime artificial light radiance and percentile.",
    })

    # 2. Thermal LST
    t_src = s.sources.get("thermal_lst")
    t_view = s.source_view("thermal_lst") if t_src else None
    t_data = getattr(st, "thermal_data", None)
    t_cells = t_data.get("cells", []) if t_data else []
    t_unknown = sum(1 for c in t_cells if c.get("value") is None or c.get("status") == "UNKNOWN") if t_cells else 0
    layers_meta.append({
        "id": "thermal_lst",
        "name": "Night surface temperature (MODIS Aqua)",
        "source": t_data.get("source") if t_data else "NASA LP DAAC / Microsoft Planetary Computer",
        "product": t_data.get("product") if t_data else "MYD11A2.061",
        "date_range": t_data.get("acquired_range") if t_data else None,
        "retrieved_at": t_data.get("retrieved_at") if t_data else None,
        "native_resolution": t_data.get("native_resolution", "1 km (Sinusoidal tile grid, nominal 926.6 m)") if t_data else "1 km",
        "units": t_data.get("unit", "°C") if t_data else "°C",
        "license": t_data.get("license") if t_data else "NASA Open Data Policy (CC0 / Public Domain)",
        "attribution": t_data.get("attribution") if t_data else "NASA EOSDIS LP DAAC",
        "status": t_view.status if t_view else "UNKNOWN",
        "confidence": t_view.confidence if t_view else 0.0,
        "age_s": t_view.age_s if t_view else None,
        "available": bool(t_data and t_src and t_src.enabled),
        "cell_count": len(t_cells),
        "unknown_share": round((t_unknown / max(1, len(t_cells))) * 100, 1),
        "synthetic": False,
        "note": "1 km land-surface temperature from MODIS Aqua night pass (~01:30 local). Cloud-masked cells remain UNKNOWN.",
    })

    # 3. Weather Grid
    w_src = s.sources.get("weather_grid")
    w_view = s.source_view("weather_grid") if w_src else None
    w_data = getattr(st, "weather_grid_data", None)
    w_points = w_data.get("points", []) if w_data else []
    w_times = w_points[0].get("hourly", {}).get("time", []) if w_points else []
    w_date_range = f"{w_times[0]} to {w_times[-1]}" if w_times else None
    layers_meta.append({
        "id": "weather_grid",
        "name": "Weather forecast grid (Open-Meteo)",
        "source": w_data.get("source") if w_data else "Open-Meteo API / DWD ICON & ECMWF IFS",
        "product": w_data.get("model") if w_data else "ECMWF IFS / DWD ICON blended forecast",
        "date_range": w_date_range,
        "retrieved_at": w_data.get("retrieved_at") if w_data else None,
        "native_resolution": w_data.get("native_resolution", "0.1° (~11 km) sampled at 2.0 km grid") if w_data else "2.0 km grid",
        "units": w_data.get("units", {}).get("temperature_2m", "°C") if w_data else "°C",
        "license": w_data.get("license") if w_data else "Weather data by Open-Meteo.com (CC BY 4.0)",
        "attribution": w_data.get("attribution") if w_data else "Open-Meteo.com under CC BY 4.0",
        "status": w_view.status if w_view else "UNKNOWN",
        "confidence": w_view.confidence if w_view else 0.0,
        "age_s": w_view.age_s if w_view else None,
        "available": bool(w_data and w_src and w_src.enabled),
        "cell_count": len(w_points),
        "unknown_share": 0.0,
        "synthetic": False,
        "note": "2 km multi-point hourly forecast grid driving air temperature, wind, and precipitation layers.",
    })

    return layers_meta


@router.get("/layers/{layer_id}")
def get_layer(layer_id: str, hour: Optional[int] = None):
    e = eng()
    st = e.static
    s = e.state

    if layer_id == "viirs_ntl":
        data = getattr(st, "viirs_data", None)
        if not data:
            raise HTTPException(404, "Layer 'viirs_ntl' file is absent. Run scripts/fetch_viirs.py first.")
        cell_size = float(data.get("cell_size_deg", 0.004167))
        half = cell_size / 2.0
        unit = data.get("unit", "nW·cm⁻²·sr⁻¹")
        acq = data.get("retrieved_at")
        feats = []
        for r in data.get("rows", []):
            lat, lon = float(r["lat"]), float(r["lon"])
            val = r.get("radiance")
            status_val = "UNKNOWN" if (val is None or r.get("status_hint") == "UNKNOWN") else "KNOWN"
            coords = [
                [round(lon - half, 6), round(lat - half, 6)],
                [round(lon + half, 6), round(lat - half, 6)],
                [round(lon + half, 6), round(lat + half, 6)],
                [round(lon - half, 6), round(lat + half, 6)],
                [round(lon - half, 6), round(lat - half, 6)],
            ]
            feats.append({
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [coords]},
                "properties": {
                    "i": r.get("i"),
                    "j": r.get("j"),
                    "lat": lat,
                    "lon": lon,
                    "value": val,
                    "percentile": r.get("percentile"),
                    "unit": unit,
                    "status": status_val,
                    "acquisition_time": acq,
                }
            })
        return {
            "type": "FeatureCollection",
            "layer_id": layer_id,
            "metadata": {
                "source": data.get("source"),
                "product": data.get("product"),
                "native_resolution": data.get("native_resolution"),
                "unit": unit,
                "cell_size_deg": cell_size,
            },
            "features": feats,
        }

    elif layer_id == "thermal_lst":
        data = getattr(st, "thermal_data", None)
        if not data:
            raise HTTPException(404, "Layer 'thermal_lst' file is absent. Run scripts/fetch_thermal.py first.")
        dlat = 926.625 / 111195.0
        unit = data.get("unit", "°C")
        acq = data.get("acquisition_time") or data.get("retrieved_at")
        feats = []
        for c in data.get("cells", []):
            lat, lon = float(c["lat"]), float(c["lon"])
            cos_l = math.cos(math.radians(lat))
            dlon = dlat / cos_l if abs(cos_l) > 1e-6 else dlat
            half_lat = dlat / 2.0
            half_lon = dlon / 2.0
            val = c.get("value")
            status_val = c.get("status", "UNKNOWN") if val is not None else "UNKNOWN"
            coords = [
                [round(lon - half_lon, 6), round(lat - half_lat, 6)],
                [round(lon + half_lon, 6), round(lat - half_lat, 6)],
                [round(lon + half_lon, 6), round(lat + half_lat, 6)],
                [round(lon - half_lon, 6), round(lat + half_lat, 6)],
                [round(lon - half_lon, 6), round(lat - half_lat, 6)],
            ]
            feats.append({
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [coords]},
                "properties": {
                    "i": c.get("i"),
                    "j": c.get("j"),
                    "lat": lat,
                    "lon": lon,
                    "value": val,
                    "unit": unit,
                    "status": status_val,
                    "quality": c.get("quality", "clear"),
                    "acquisition_time": c.get("acquisition_time") or acq,
                }
            })
        return {
            "type": "FeatureCollection",
            "layer_id": layer_id,
            "metadata": {
                "source": data.get("source"),
                "product": data.get("product"),
                "native_resolution": data.get("native_resolution"),
                "unit": unit,
            },
            "features": feats,
        }

    elif layer_id == "weather_grid":
        data = getattr(st, "weather_grid_data", None)
        if not data:
            raise HTTPException(404, "Layer 'weather_grid' file is absent. Run scripts/fetch_weather_grid.py first.")

        h_idx = 2  # default 02:00
        if hour is not None:
            h_idx = max(0, int(hour))
        else:
            sim_h = s.now().hour
            h_idx = sim_h

        unit = data.get("units", {}).get("temperature_2m", "°C")
        grid_km = float(data.get("grid_spacing_km", 2.0))
        dlat = (grid_km * 1000.0) / 111195.0
        acq = data.get("retrieved_at")

        feats = []
        for pt in data.get("points", []):
            lat, lon = float(pt["lat"]), float(pt["lon"])
            cos_l = math.cos(math.radians(lat))
            dlon = dlat / cos_l if abs(cos_l) > 1e-6 else dlat
            half_lat = dlat / 2.0
            half_lon = dlon / 2.0

            hly = pt.get("hourly", {})
            times = hly.get("time", [])
            idx = min(h_idx, len(times) - 1) if times else 0
            t_str = times[idx] if idx < len(times) else None
            temp = hly.get("temperature_2m", [])[idx] if idx < len(hly.get("temperature_2m", [])) else None
            app_temp = hly.get("apparent_temperature", [])[idx] if idx < len(hly.get("apparent_temperature", [])) else None
            precip = hly.get("precipitation", [])[idx] if idx < len(hly.get("precipitation", [])) else None
            cloud = hly.get("cloud_cover", [])[idx] if idx < len(hly.get("cloud_cover", [])) else None
            wind = hly.get("wind_speed_10m", [])[idx] if idx < len(hly.get("wind_speed_10m", [])) else None
            rh = hly.get("relative_humidity_2m", [])[idx] if idx < len(hly.get("relative_humidity_2m", [])) else None

            coords = [
                [round(lon - half_lon, 6), round(lat - half_lat, 6)],
                [round(lon + half_lon, 6), round(lat - half_lat, 6)],
                [round(lon + half_lon, 6), round(lat + half_lat, 6)],
                [round(lon - half_lon, 6), round(lat + half_lat, 6)],
                [round(lon - half_lon, 6), round(lat - half_lat, 6)],
            ]
            feats.append({
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [coords]},
                "properties": {
                    "id": pt.get("id"),
                    "lat": lat,
                    "lon": lon,
                    "hour": h_idx,
                    "time": t_str,
                    "value": temp,
                    "temperature_2m": temp,
                    "apparent_temperature": app_temp,
                    "precipitation": precip,
                    "cloud_cover": cloud,
                    "wind_speed_10m": wind,
                    "relative_humidity_2m": rh,
                    "unit": unit,
                    "status": "KNOWN" if temp is not None else "UNKNOWN",
                    "acquisition_time": acq,
                }
            })

        return {
            "type": "FeatureCollection",
            "layer_id": layer_id,
            "hour": h_idx,
            "metadata": {
                "source": data.get("source"),
                "model": data.get("model"),
                "native_resolution": data.get("native_resolution"),
                "units": data.get("units", {}),
            },
            "features": feats,
        }

    else:
        raise HTTPException(404, f"Layer '{layer_id}' not recognized. Supported: viirs_ntl, thermal_lst, weather_grid.")


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

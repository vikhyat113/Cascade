"""Shared fixtures: a tiny synthetic city (7x7 grid, 150 m blocks) so tests are
fast, deterministic and independent of the downloaded OSM data.

Layout: the outer ring is a lit primary road; inner streets are residential
with no lighting data (UNKNOWN). A 24/7 hospital, a police post and a pharmacy
without hours; one night bus along the south edge.
"""
import copy
import gzip
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.adapters.geo import LocalProjection  # noqa: E402
from app.config import get_config  # noqa: E402

LAT0, LON0 = 28.57, 77.32
N, STEP = 7, 150.0
GEN = "2026-10-20T12:00:00+00:00"


def _grid(proj, directed):
    ids, lat, lon = [], [], []
    for j in range(N):
        for i in range(N):
            la, lo = proj.latlon((i - 3) * STEP, (j - 3) * STEP)
            ids.append(1000 + j * N + i)
            lat.append(round(float(la), 6))
            lon.append(round(float(lo), 6))
    E = {k: [] for k in ("u", "v", "len", "hw", "lit", "name", "speed", "geom")}

    def add(a, b, ring):
        for u, v in ((a, b), (b, a)) if directed else ((a, b),):
            E["u"].append(u)
            E["v"].append(v)
            E["len"].append(STEP)
            E["hw"].append("primary" if ring else "residential")
            E["lit"].append("yes" if ring else None)
            E["name"].append("Ring Road" if ring else f"Lane {min(u, v)}")
            E["speed"].append(40.0 if ring else 25.0)
            E["geom"].append([[lon[u], lat[u]], [lon[v], lat[v]]])

    for j in range(N):
        for i in range(N):
            k = j * N + i
            if i + 1 < N:
                add(k, k + 1, j in (0, N - 1))
            if j + 1 < N:
                add(k, k + N, i in (0, N - 1))
    return {"generated_at": GEN, "directed": directed, "nodes": {"id": ids, "lat": lat, "lon": lon}, "edges": E}


def _node(proj, i, j):
    la, lo = proj.latlon((i - 3) * STEP, (j - 3) * STEP)
    return round(float(la), 6), round(float(lo), 6)


@pytest.fixture(scope="session")
def tiny_data(tmp_path_factory):
    d = tmp_path_factory.mktemp("tiny")
    proj = LocalProjection(LAT0, LON0)
    for name, directed in (("walk", False), ("drive", True)):
        with gzip.open(d / f"graph_{name}.json.gz", "wt", encoding="utf-8") as f:
            json.dump(_grid(proj, directed), f)
    h = _node(proj, 6, 6)
    pol = _node(proj, 0, 3)
    ph = _node(proj, 3, 3)
    pois = [
        {"id": "n1", "cat": "hospital", "lat": h[0], "lon": h[1], "name": "Tiny Hospital",
         "edited_at": "2026-06-01T00:00:00Z", "tags": {"opening_hours": "24/7", "emergency": "yes"}},
        {"id": "n2", "cat": "police", "lat": pol[0], "lon": pol[1], "name": "Tiny Police Post", "edited_at": None, "tags": {}},
        {"id": "n3", "cat": "pharmacy", "lat": ph[0], "lon": ph[1], "name": "No-Hours Pharmacy", "edited_at": None, "tags": {}},
        {"id": "n4", "cat": "place", "lat": _node(proj, 0, 0)[0], "lon": _node(proj, 0, 0)[1], "name": "Southwest Gate", "tags": {}},
        {"id": "n5", "cat": "place", "lat": _node(proj, 6, 6)[0], "lon": _node(proj, 6, 6)[1], "name": "Northeast Home", "tags": {}},
    ]
    (d / "pois.json").write_text(json.dumps({"generated_at": GEN, "pois": pois}), encoding="utf-8")
    stops = [{"id": f"s{i}", "name": f"South {i}", "lat": _node(proj, i, 0)[0], "lon": _node(proj, i, 0)[1]} for i in range(0, 7, 2)]
    stops += [{"id": "s9", "name": "East Top", "lat": _node(proj, 6, 6)[0], "lon": _node(proj, 6, 5)[1]}]
    (d / "transit_schedule.json").write_text(json.dumps({
        "generated_at": GEN, "synthetic": True, "source": "test",
        "routes": [{"id": "T1", "name": "Night bus T1", "mode": "bus", "stops": stops, "seg_s": [60, 60, 60, 120],
                    "service": [{"from": "21:00", "to": "05:00", "headway_min": 15}], "both_directions": True}]}),
        encoding="utf-8")
    hours = [f"2026-10-{dd}T{hh:02d}:00" for dd in (25, 26) for hh in range(24)]
    (d / "weather_cache.json").write_text(json.dumps({
        "fetched_at": "2026-10-25T18:00:00+00:00",
        "hourly": {"time": hours, "temperature_2m": [24] * 48, "precipitation_probability": [0] * 48,
                   "precipitation": [0.0] * 48, "rain": [0.0] * 48, "wind_speed_10m": [5] * 48,
                   "weather_code": [0] * 48, "visibility": [20000] * 48}}), encoding="utf-8")
    return d


@pytest.fixture(scope="session")
def tiny_cfg():
    cfg = copy.deepcopy(get_config())
    cfg.update({"center": {"lat": LAT0, "lon": LON0}, "radius_m": 700, "city_name": "Tiny test city",
                "personas": [], "seed": 7})
    cfg["sim"] = {**cfg["sim"], "night_date": "2026-10-25", "start_time": "02:00", "warmup_s": 300}
    return cfg


@pytest.fixture(scope="session")
def tiny_static(tiny_cfg, tiny_data):
    from app.core.world import StaticWorld
    return StaticWorld(tiny_cfg, tiny_data)


@pytest.fixture()
def engine(tiny_cfg, tiny_static):
    from app.core.clock import ManualClock, night_time
    from app.core.engine import Engine
    clock = ManualClock(night_time("02:00", tiny_static.night, tiny_static.tz))
    return Engine(cfg=tiny_cfg, static=tiny_static, clock=clock, live=False, warmup=True, seed=7)


@pytest.fixture()
def corners(tiny_static):
    sw = tiny_static.geocode("Southwest Gate", 1)[0]
    ne = tiny_static.geocode("Northeast Home", 1)[0]
    return sw, ne


def utc(*a):
    return datetime(*a, tzinfo=timezone.utc)

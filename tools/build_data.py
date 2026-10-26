"""Build the data bundled in the APK (spec §6):  `npm run data`  (or  python tools/build_data.py)

Reads the demo area and cached downloads already in the repo (backend/config.yaml, data/),
and writes compact JSON into frontend/src/data/:

  graph.json      walkable street graph (real OSM): nodes [lat, lon], edges with length, road
                  class, lit (1/0/-1), lamps within 15 m, name, simplified geometry (~2 m)
  pois.json       hospitals, clinics, pharmacies, police, fire, fuel, ATMs, food/shops, stops
                  (real OSM) with opening_hours / phone or null
  places.json     offline search list: named places, stops and streets (real OSM)
  weather.json    Open-Meteo hourly snapshot with fetched_at (real)
  incidents.json  SYNTHETIC seeded incident density per grid cell per night hour
  schedule.json   SYNTHETIC hand-built night timetable on real bus-stop locations
  meta.json       area, timezone, Home / Work / start defaults, what is real vs synthetic

If the cached data is missing (no internet when it was fetched), a small SAMPLE city is
generated instead so the app always runs. The script prints what was real and what was not.
Laptop only: needs backend/.venv (numpy, scipy, osmnx for re-downloads).
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "frontend" / "src" / "data"
sys.path.insert(0, str(ROOT / "backend"))

LIT_YES = {"yes", "24/7", "automatic", "sunset-sunrise", "interval", "dusk-dawn", "limited"}
LIT_NO = {"no", "disused"}
POI_TYPES = {"hospital", "clinic", "pharmacy", "police", "fire_station", "fuel", "atm", "food", "shop",
             "bus_stop", "metro_station", "rail_station", "toilets", "bank", "hotel"}


def zones() -> list[dict]:
    """The named zones (data/area.geojson, built by scripts/area.py) as [lat, lon] rings for the app."""
    p = ROOT / "data" / "area.geojson"
    if not p.exists():
        return []
    fc = json.loads(p.read_text(encoding="utf-8"))
    return [{"id": f["properties"]["id"], "name": f["properties"]["name"], "detail": f["properties"]["detail"],
             "ring": [[round(lat, 5), round(lon, 5)] for lon, lat in f["geometry"]["coordinates"][0]]}
            for f in fc["features"]]


def write(name: str, obj) -> int:
    p = OUT / name
    p.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    return p.stat().st_size


def simplify(pts: list[tuple[float, float]], tol: float) -> list[int]:
    """Douglas-Peucker on projected points; returns kept indices."""
    if len(pts) <= 2:
        return list(range(len(pts)))
    keep = {0, len(pts) - 1}
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy) or 1e-9
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / L
            if d > best:
                best, bi = d, i
        if best > tol:
            keep.add(bi)
            stack += [(a, bi), (bi, b)]
    return sorted(keep)


def seg_dist(px, py, ax, ay, bx, by) -> float:
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    k = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - ax - k * dx, py - ay - k * dy)


def viirs_sampler():
    """Night-light brightness (0-255, -1 = none) at a point, from data/viirs_ntl.json (scripts/fetch_viirs.py)."""
    p = ROOT / "data" / "viirs_ntl.json"
    if not p.exists():
        return None, None
    v = json.loads(p.read_text(encoding="utf-8"))
    b, c, nx, ny, vals = v["bbox"], v["cell_deg"], v["nx"], v["ny"], v["values"]
    def at(lat, lon):
        r, k = int((b["north"] - lat) / c), int((lon - b["west"]) / c)
        return vals[r * nx + k] if 0 <= r < ny and 0 <= k < nx else -1
    return at, v


def write_layers():
    """Map-layer files, fetched by the app only when a layer is switched on (UPGRADE §3: lazy)."""
    out = OUT / "layers"
    out.mkdir(parents=True, exist_ok=True)
    sizes = {}
    _, v = viirs_sampler()
    if v:
        (out / "viirs.json").write_text(json.dumps({k: v[k] for k in ("source", "licence", "note", "nights", "bbox", "cell_deg", "nx", "ny", "values")},
                                                   separators=(",", ":")), encoding="utf-8")
        sizes["layers/viirs.json"] = (out / "viirs.json").stat().st_size
    wg = ROOT / "data" / "weather_grid.json"
    if wg.exists():
        (out / "weather.json").write_text(wg.read_text(encoding="utf-8"), encoding="utf-8")
        sizes["layers/weather.json"] = (out / "weather.json").stat().st_size
    return sizes


def build_real():
    from app.config import data_dir, get_config
    from app.core.world import StaticWorld
    from scipy.spatial import cKDTree

    cfg = get_config()
    st = StaticWorld(cfg, data_dir())
    proj = st.proj
    G = st.walk
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # ---- graph ---------------------------------------------------------------------------
    lamps = [p for p in st.pois if p.cat == "street_lamp"]
    lamp_tree = cKDTree([[p.x, p.y] for p in lamps]) if lamps else None
    hw_codes, names = [], []
    hw_idx, name_idx = {}, {}
    E = {k: [] for k in ("u", "v", "len", "hw", "lit", "lamps", "name", "geom", "ntl")}
    ntl_at, _ = viirs_sampler()
    for e in range(G.m):
        hw = G.ehw[e]
        if hw not in hw_idx:
            hw_idx[hw] = len(hw_codes)
            hw_codes.append(hw)
        nm = G.ename[e]
        if nm and nm not in name_idx:
            name_idx[nm] = len(names)
            names.append(nm)
        lit = (G.elit[e] or "").lower()
        geom = G.egeom[e]                                   # [[lon, lat], ...]
        xy = [tuple(map(float, proj.xy(lat, lon))) for lon, lat in geom]
        kept = simplify(xy, 2.0)
        n_lamps = 0
        if lamp_tree is not None:
            cx, cy = float(G.emx[e]), float(G.emy[e])
            for i in lamp_tree.query_ball_point([cx, cy], float(G.elen[e]) / 2 + 15):
                lx, ly = lamps[i].x, lamps[i].y
                if min(seg_dist(lx, ly, *xy[k], *xy[k + 1]) for k in range(len(xy) - 1)) <= 15:
                    n_lamps += 1
        E["u"].append(int(G.eu[e]))
        E["v"].append(int(G.ev[e]))
        E["len"].append(round(float(G.elen[e]), 1))
        E["hw"].append(hw_idx[hw])
        E["lit"].append(1 if lit in LIT_YES else 0 if lit in LIT_NO else -1)
        E["lamps"].append(n_lamps)
        E["name"].append(name_idx[nm] if nm else -1)
        E["geom"].append([round(v, 6) for k in kept for v in (geom[k][1], geom[k][0])])  # flat lat,lon
        E["ntl"].append(ntl_at(float(G.emlat[e]), float(G.emlon[e])) if ntl_at else -1)    # night lights from satellite
    graph = {"source": "OpenStreetMap contributors via OSMnx (real)", "generated_at": G.generated_at,
             "nodes": [[round(float(a), 6), round(float(b), 6)] for a, b in zip(G.lat, G.lon)],
             "edges": E, "hw_codes": hw_codes, "names": names, "grid_m": 250}

    # ---- POIs + places -----------------------------------------------------------------------
    raw_tags = {}
    raw = ROOT / "data" / "raw" / "overpass_pois.json"
    if raw.exists():
        for el in json.loads(raw.read_text(encoding="utf-8")).get("elements", []):
            raw_tags[f"{el['type'][0]}{el['id']}"] = el.get("tags", {})
    pois = []
    for p in st.pois:
        if p.cat not in POI_TYPES:
            continue
        tags = raw_tags.get(p.id, p.tags)
        pois.append({"id": p.id, "type": p.cat, "name": p.name, "lat": round(p.lat, 6), "lon": round(p.lon, 6),
                     "opening_hours": p.tags.get("opening_hours"),
                     "phone": tags.get("phone") or tags.get("contact:phone"),
                     "emergency": p.tags.get("emergency"),
                     "edited_at": p.edited_at.isoformat() if p.edited_at else None})
    places = [{"name": pl.name, "lat": round(pl.lat, 6), "lon": round(pl.lon, 6), "kind": pl.kind}
              for pl in st.places]

    # ---- weather snapshot -----------------------------------------------------------------------
    wc = json.loads((data_dir() / "weather_cache.json").read_text(encoding="utf-8"))
    H = wc["hourly"]
    weather = {"source": "Open-Meteo.com (CC BY 4.0), real snapshot", "fetched_at": wc["fetched_at"],
               "timezone": wc.get("timezone"), "hourly": {k: H.get(k) for k in (
                   "time", "temperature_2m", "precipitation_probability", "precipitation", "rain",
                   "wind_speed_10m", "weather_code", "visibility")}}

    # ---- incidents (synthetic) --------------------------------------------------------------------
    gr = st.grid
    hours = list(range(18, 24)) + list(range(0, 8))
    incidents = {"synthetic": True, "seed": st.seed,
                 "source": "seeded synthetic incident history, biased by real OSM proxies",
                 "grid": {"xmin": gr.xmin, "ymin": gr.ymin, "size": gr.size, "nx": gr.nx, "ny": gr.ny},
                 "risk": {str(h): [round(float(v), 3) for v in st.incidents.risk[h]] for h in hours}}

    # ---- schedule (synthetic) -----------------------------------------------------------------------
    sched = json.loads((data_dir() / "transit_schedule.json").read_text(encoding="utf-8"))
    sched["synthetic"] = True

    # ---- meta --------------------------------------------------------------------------------------
    d = cfg.get("presentation", {}).get("ui_defaults", {})
    per = next((p for p in st.personas if p["id"] == d.get("persona")), st.personas[0])
    meta = {
        "city_name": cfg["city_name"], "center": {"lat": st.center[0], "lon": st.center[1]},
        "radius_m": st.radius, "timezone": cfg["timezone"], "tz_offset_min": 330, "seed": st.seed,
        "night_hours": cfg["risk"].get("night_hours", [19, 6]),
        "zones": zones(),
        "ui_defaults": {"home": per["home_point"], "work": per["origin_point"], "start": d.get("start_at") or per["origin_point"],
                        "deadline": d.get("deadline")},
        "generated_at": now, "sample": False,
        "real": ["street graph (OSM)", "places + opening hours (OSM)", "lit tags (OSM)",
                 "weather snapshot (Open-Meteo)", "bus-stop and metro-station locations (OSM)", "area zones (OSM main road)",
                 "Nagpur Metro lines, stops and hours (OSM relations)", "night lights from satellite (NASA VIIRS Black Marble)",
                 "weather grid (Open-Meteo)"],
        "synthetic": ["incident history", "bus routes E1-E4 (estimated: no open bus data for Nagpur; hours unknown)",
                      "traffic", "live bus / metro status", "road closures"],
    }
    return graph, pois, places, weather, incidents, sched, meta


def build_sample(center_lat=21.145, center_lon=79.078, city="Sample city"):
    """Tiny synthetic city (7x7 blocks) so the app always runs without downloads. ALL synthetic."""
    step, n = 200.0, 9
    kx = 111320.0 * math.cos(math.radians(center_lat))
    ll = lambda i, j: [round(center_lat + (j - n // 2) * step / 110540, 6), round(center_lon + (i - n // 2) * step / kx, 6)]  # noqa: E731
    nodes = [ll(i, j) for j in range(n) for i in range(n)]
    E = {k: [] for k in ("u", "v", "len", "hw", "lit", "lamps", "name", "geom")}
    for j in range(n):
        for i in range(n):
            k = j * n + i
            for k2, ring in ((k + 1, j in (0, n - 1)) if i + 1 < n else (None, 0),
                             (k + n, i in (0, n - 1)) if j + 1 < n else (None, 0)):
                if k2 is None:
                    continue
                E["u"].append(k); E["v"].append(k2); E["len"].append(step)
                E["hw"].append(0 if ring else 1); E["lit"].append(1 if ring else -1)
                E["lamps"].append(0); E["name"].append(0 if ring else -1)
                E["geom"].append(nodes[k] + nodes[k2])
    graph = {"source": "SAMPLE synthetic grid", "generated_at": None, "nodes": nodes, "edges": E,
             "hw_codes": ["primary", "residential"], "names": ["Ring Road"], "grid_m": 250}
    c = nodes[(n // 2) * n + n // 2]
    pois = [{"id": "s1", "type": "hospital", "name": "Sample Hospital", "lat": nodes[n * n - 1][0], "lon": nodes[n * n - 1][1],
             "opening_hours": "24/7", "phone": None, "emergency": "yes", "edited_at": None},
            {"id": "s2", "type": "police", "name": "Sample Police", "lat": nodes[n][0], "lon": nodes[n][1],
             "opening_hours": None, "phone": None, "emergency": None, "edited_at": None},
            {"id": "s3", "type": "pharmacy", "name": "Sample Pharmacy", "lat": c[0], "lon": c[1],
             "opening_hours": None, "phone": None, "emergency": None, "edited_at": None}]
    places = [{"name": "Sample Home", "lat": nodes[-1][0], "lon": nodes[-1][1], "kind": "area"},
              {"name": "Sample Work", "lat": nodes[0][0], "lon": nodes[0][1], "kind": "area"}]
    weather = {"source": "none (sample)", "fetched_at": None, "hourly": {"time": []}}
    incidents = {"synthetic": True, "seed": 1, "grid": {"xmin": -1000, "ymin": -1000, "size": 250, "nx": 8, "ny": 8},
                 "risk": {str(h): [0.2] * 64 for h in list(range(18, 24)) + list(range(0, 8))}}
    sched = {"synthetic": True, "generated_at": None, "routes": [{
        "id": "S1", "name": "Sample bus S1", "mode": "bus", "color": "#f59e0b",
        "stops": [{"id": f"b{i}", "name": f"Stop {i + 1}", "lat": nodes[i * 2][0], "lon": nodes[i * 2][1]} for i in range(5)],
        "seg_s": [90] * 4, "service": [{"from": "21:00", "to": "05:00", "headway_min": 20}], "both_directions": True}]}
    meta = {"city_name": city, "center": {"lat": center_lat, "lon": center_lon}, "radius_m": 1200, "zones": [],
            "timezone": "Asia/Kolkata", "tz_offset_min": 330, "seed": 1, "night_hours": [19, 6],
            "ui_defaults": {"home": {**places[0], "name": "Sample Home"}, "work": {**places[1], "name": "Sample Work"},
                            "start": {**places[1], "name": "Sample Work"}, "deadline": "03:00"},
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "sample": True,
            "real": [], "synthetic": ["everything (sample city)"]}
    return graph, pois, places, weather, incidents, sched, meta


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        bundle = build_real()
        print("Built from the cached real data (data/).")
    except Exception as e:                          # missing downloads, missing venv, ...
        print(f"Real data unavailable ({e!r}); generating a SAMPLE city instead.")
        bundle = build_sample()
    names = ["graph.json", "pois.json", "places.json", "weather.json", "incidents.json", "schedule.json", "meta.json"]
    total = 0
    for name, obj in zip(names, bundle):
        size = write(name, obj)
        total += size
        print(f"  {name:<15} {size / 1024:8.0f} KB")
    meta = bundle[-1]
    print(f"  total           {total / 1024:8.0f} KB  (limit for graph.json: 8 MB)")
    for name, size in write_layers().items():
        print(f"  {name:<15} {size / 1024:8.0f} KB  (lazy: loaded when the layer is switched on)")
    print("Real:      " + (", ".join(meta["real"]) or "nothing"))
    print("Synthetic: " + ", ".join(meta["synthetic"]))


if __name__ == "__main__":
    main()

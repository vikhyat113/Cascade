"""The demo area as named ZONES (UPGRADE §2): two full-detail circles joined by a thin corridor
along the real main road between them. Writes data/area.geojson (a FeatureCollection).

    backend/.venv/Scripts/python scripts/area.py [--force]

Ideas from `changes` (scripts/check_area.py, adapters/area.py) kept: lon/lat order checks, validity,
vertex cap. Difference: `changes` kept only the largest polygon; here every zone is kept and named,
and each zone says how much street detail it gets ("full" walk network, or "major" roads only).
"""
from __future__ import annotations

import json
import math
import sys

from shapely.geometry import LineString, Point, Polygon, mapping, shape
from shapely.ops import unary_union

from common import CFG, DATA, RAW, haversine_m, utc_now_iso

AREA_PATH = DATA / "area.geojson"


class Local:
    """Equirectangular metres around a reference point (fine at city scale)."""
    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = 111320.0 * math.cos(math.radians(lat0))
        self.ky = 110540.0

    def xy(self, lat, lon):
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)

    def ll(self, x, y):
        return (self.lat0 + y / self.ky, self.lon0 + x / self.kx)


def _to_ll(poly: Polygon, P: Local, max_vertices: int = 120) -> Polygon:
    tol = 5.0
    while len(poly.exterior.coords) > max_vertices and tol < 500:
        poly = poly.simplify(tol, preserve_topology=True)
        tol *= 1.6
    return Polygon([(lon, lat) for lat, lon in (P.ll(x, y) for x, y in poly.exterior.coords)])   # GeoJSON: lon, lat


def corridor_line(zones: list[dict], highways: str) -> list[tuple[float, float]]:
    """Shortest path on the real main roads between the first two zone centres ([(lat, lon), ...])."""
    import networkx as nx
    import osmnx as ox

    a, b = zones[0], zones[1]
    pad = 0.03
    north, south = max(a["lat"], b["lat"]) + pad, min(a["lat"], b["lat"]) - pad
    east, west = max(a["lon"], b["lon"]) + pad, min(a["lon"], b["lon"]) - pad
    ox.settings.use_cache = True
    ox.settings.cache_folder = str(RAW / "osmnx_cache")
    ox.settings.http_user_agent = CFG["user_agent"]
    ox.settings.requests_timeout = 300
    last = None
    for url in CFG["overpass_urls"]:
        ox.settings.overpass_url = url.rsplit("/interpreter", 1)[0]
        try:
            G = ox.graph_from_bbox((west, south, east, north), custom_filter=f'["highway"~"{highways}"]', simplify=True, retain_all=False)
            break
        except Exception as e:  # mirror down, timeout
            last = e
            print(f"    {url}: {e!r}")
    else:
        sys.exit(f"could not download the corridor roads: {last!r}")
    G = ox.convert.to_undirected(G)
    near = lambda lat, lon: min(G.nodes, key=lambda n: haversine_m(lat, lon, G.nodes[n]["y"], G.nodes[n]["x"]))  # noqa: E731
    na, nb = near(a["lat"], a["lon"]), near(b["lat"], b["lon"])
    path = nx.shortest_path(G, na, nb, weight="length")
    pts: list[tuple[float, float]] = []
    for u, v in zip(path, path[1:]):
        d = min(G.get_edge_data(u, v).values(), key=lambda d: d.get("length", 1e9))
        if "geometry" in d:
            seg = [(y, x) for x, y in d["geometry"].coords]
            if haversine_m(*seg[0], G.nodes[u]["y"], G.nodes[u]["x"]) > 1:
                seg.reverse()
        else:
            seg = [(G.nodes[u]["y"], G.nodes[u]["x"]), (G.nodes[v]["y"], G.nodes[v]["x"])]
        pts.extend(seg if not pts else seg[1:])
    names = sorted({str(d.get("name")) for u, v in zip(path, path[1:]) for d in G.get_edge_data(u, v).values() if d.get("name")})
    km = sum(haversine_m(*p, *q) for p, q in zip(pts, pts[1:])) / 1000
    print(f"  corridor road: {km:.1f} km via {', '.join(names[:4])}")
    return pts


def build(force: bool = False) -> dict:
    if AREA_PATH.exists() and not force:
        return json.loads(AREA_PATH.read_text(encoding="utf-8"))
    acfg = CFG["area"]
    zones = acfg["zones"]
    P = Local(CFG["center"]["lat"], CFG["center"]["lon"])
    feats = []
    for z in zones:
        x, y = P.xy(z["lat"], z["lon"])
        poly = _to_ll(Point(x, y).buffer(z["radius_m"], 64), P)
        feats.append({"type": "Feature", "properties": {"id": z["id"], "name": z["name"], "detail": "full",
                                                        "center": [z["lat"], z["lon"]], "radius_m": z["radius_m"]},
                      "geometry": mapping(poly)})
    c = acfg.get("corridor")
    if c:
        line = corridor_line(zones, c["highways"])
        ls = LineString([P.xy(lat, lon) for lat, lon in line])
        poly = _to_ll(ls.buffer(c["buffer_m"], 16), P)
        feats.append({"type": "Feature", "properties": {"id": c["id"], "name": c["name"], "detail": "major",
                                                        "highways": c["major_highways"], "buffer_m": c["buffer_m"],
                                                        "road": [[round(a, 6), round(b, 6)] for a, b in line[:: max(1, len(line) // 200)]]},
                      "geometry": mapping(poly)})
    fc = {"type": "FeatureCollection", "generated_at": utc_now_iso(), "name": CFG["city_name"],
          "source": "zones from config.yaml; corridor = buffer along the OSM main-road path (OpenStreetMap contributors)",
          "features": feats}
    check(fc)
    AREA_PATH.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    print(f"  wrote {AREA_PATH.name}: {len(feats)} zones")
    return fc


def check(fc: dict) -> None:
    """Validity, lon/lat order, and that the configured centre/radius encloses every zone."""
    P = Local(CFG["center"]["lat"], CFG["center"]["lon"])
    far = 0.0
    for f in fc["features"]:
        g = shape(f["geometry"])
        if not g.is_valid or g.is_empty:
            raise ValueError(f"zone {f['properties']['id']} is not a valid polygon")
        for lon, lat in g.exterior.coords:
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise ValueError("coordinates out of range")
            if 15 <= lon <= 35 and 65 <= lat <= 85:
                raise ValueError("coordinates look like (lat, lon); GeoJSON needs (lon, lat)")
            far = max(far, math.hypot(*P.xy(lat, lon)))
    if far > CFG["radius_m"]:
        raise ValueError(f"config radius_m {CFG['radius_m']} does not enclose the zones (needs {far:.0f} m)")


def polygons() -> list[tuple[dict, Polygon]]:
    """[(properties, shapely Polygon in lon/lat)] for every zone."""
    fc = build()
    return [(f["properties"], shape(f["geometry"])) for f in fc["features"]]


def union():
    return unary_union([p for _, p in polygons()])


def overpass_poly(poly: Polygon, max_vertices: int = 80) -> str:
    """Overpass `poly:"lat lon ..."` filter for a zone."""
    tol = 0.0002
    while len(poly.exterior.coords) > max_vertices:
        poly = poly.simplify(tol, preserve_topology=True)
        tol *= 1.5
    return 'poly:"' + " ".join(f"{lat:.5f} {lon:.5f}" for lon, lat in list(poly.exterior.coords)[:-1]) + '"'


if __name__ == "__main__":
    fc = build(force="--force" in sys.argv)
    for f in fc["features"]:
        p = f["properties"]
        print(f"  {p['id']:<10} {p['name']:<32} detail={p['detail']}  vertices={len(f['geometry']['coordinates'][0])}")

"""Shared helpers for the one-off data download / build scripts.

Everything here runs *before* the demo. Results are cached under data/ and the
backend only ever reads those files, so no public API is hit during the demo.
"""
from __future__ import annotations

import gzip
import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
CONFIG_PATH = BACKEND / "config.yaml"

if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.adapters.geo import LocalProjection, haversine_m  # noqa: E402
from shapely.geometry import Point, Polygon, shape  # noqa: E402
from shapely.validation import explain_validity  # noqa: E402


class Area:
    """Polygon-defined demo area in EPSG:4326 with buffer, centroid, bbox and Overpass poly string."""

    def __init__(self, polygon: Polygon, buffer_m: float = 300.0, raw_geojson: dict | None = None,
                 source_path: str = "memory", source_mtime: str = ""):
        self.polygon = polygon
        self.buffer_m = float(buffer_m)
        self.raw_geojson = raw_geojson
        self.source_path = source_path
        self.source_mtime = source_mtime or utc_now_iso()
        self.placeholder_suspect = False
        self._init_properties()

    def _init_properties(self) -> None:
        c = self.polygon.centroid
        self.centroid = {"lat": round(float(c.y), 6), "lon": round(float(c.x), 6)}
        minx, miny, maxx, maxy = self.polygon.bounds
        self.bbox = [round(float(minx), 6), round(float(miny), 6), round(float(maxx), 6), round(float(maxy), 6)]

        coords = list(self.polygon.exterior.coords)
        ring = coords[:-1] if len(coords) > 1 and coords[0] == coords[-1] else coords
        if len(ring) >= 3:
            dists = [haversine_m(self.centroid["lat"], self.centroid["lon"], lat, lon) for lon, lat in ring]
            min_d, max_d = min(dists), max(dists)
            mean_d = sum(dists) / len(dists)
            spread = (max_d - min_d) / max(mean_d, 1e-6)
            # vertices all within 3 percent of the same distance from centroid, or 17 vertices with near-equal distances
            self.placeholder_suspect = bool(spread <= 0.03 or (len(coords) == 17 and spread <= 0.05))
            if self.placeholder_suspect:
                print(f"Warning: area polygon is placeholder_suspect (near-regular shape: {len(coords)} vertices, distance spread {spread*100:.2f}%)")

        proj = LocalProjection(self.centroid["lat"], self.centroid["lon"])
        local_coords = [proj.xy(lat, lon) for lon, lat in self.polygon.exterior.coords]
        local_poly = Polygon(local_coords)
        buffered_local = local_poly.buffer(self.buffer_m)
        buffered_coords = [[round(float(lon), 6), round(float(lat), 6)]
                           for x, y in buffered_local.exterior.coords
                           for lat, lon in [proj.latlon(x, y)]]
        self.buffered_polygon = Polygon(buffered_coords)

    @property
    def overpass_poly_str(self) -> str:
        p = self.buffered_polygon if self.buffered_polygon is not None else self.polygon
        coords = [f"{round(lat, 6)} {round(lon, 6)}" for lon, lat in p.exterior.coords]
        return f'poly:"{" ".join(coords)}"'

    def overpass_poly(self, poly: Polygon | None = None) -> str:
        target = poly if poly is not None else (self.buffered_polygon if self.buffered_polygon is not None else self.polygon)
        coords = [f"{round(lat, 6)} {round(lon, 6)}" for lon, lat in target.exterior.coords]
        return f'poly:"{" ".join(coords)}"'

    def contains(self, lat: float, lon: float) -> bool:
        return bool(self.polygon.covers(Point(lon, lat)))

    def contains_buffered(self, lat: float, lon: float) -> bool:
        return bool(self.buffered_polygon.covers(Point(lon, lat)))

    def max_distance_to_vertex(self) -> float:
        c = self.centroid
        return max(haversine_m(c["lat"], c["lon"], lat, lon) for lon, lat in self.polygon.exterior.coords)

    def area_km2(self) -> float:
        c = self.centroid
        proj = LocalProjection(c["lat"], c["lon"])
        local_coords = [proj.xy(lat, lon) for lon, lat in self.polygon.exterior.coords]
        return float(Polygon(local_coords).area / 1e6)

    @property
    def geojson_geometry(self) -> dict:
        return {
            "type": "Polygon",
            "coordinates": [[[round(float(lon), 6), round(float(lat), 6)] for lon, lat in self.polygon.exterior.coords]]
        }


def _extract_polygons(data: dict) -> list[Polygon]:
    """Recursively extract all Polygons from GeoJSON Polygon, MultiPolygon, Feature, or FeatureCollection."""
    polys: list[Polygon] = []
    gtype = data.get("type")
    if gtype == "FeatureCollection":
        for f in data.get("features", []):
            polys.extend(_extract_polygons(f))
    elif gtype == "Feature":
        geom = data.get("geometry")
        if geom:
            polys.extend(_extract_polygons(geom))
    elif gtype == "Polygon":
        s = shape(data)
        if isinstance(s, Polygon) and not s.is_empty:
            polys.append(s)
    elif gtype == "MultiPolygon":
        s = shape(data)
        if hasattr(s, "geoms"):
            for g in s.geoms:
                if isinstance(g, Polygon) and not g.is_empty:
                    polys.append(g)
    elif gtype == "GeometryCollection":
        for g in data.get("geometries", []):
            polys.extend(_extract_polygons(g))
    return polys


def load_area(source: str | Path | dict, buffer_m: float = 300.0) -> Area:
    """Load GeoJSON area polygon with shapely, validate, buffer, and simplify if needed."""
    source_path = "memory"
    source_mtime = datetime.now(timezone.utc).isoformat()
    if isinstance(source, (str, Path)):
        p = Path(source)
        if not p.is_absolute():
            # Check relative to BACKEND, then ROOT
            if (BACKEND / p).exists():
                p = (BACKEND / p).resolve()
            elif (ROOT / p).exists():
                p = (ROOT / p).resolve()
            else:
                p = (ROOT / p).resolve()
        if not p.exists():
            raise FileNotFoundError(f"Area polygon file not found: {p}")
        source_path = str(p)
        source_mtime = datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).isoformat()
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    elif isinstance(source, dict):
        data = source
    else:
        raise TypeError(f"Expected path or dict, got {type(source).__name__}")

    polys = _extract_polygons(data)
    if not polys:
        raise ValueError(f"No valid Polygon found in GeoJSON (got type: {data.get('type')})")

    if len(polys) > 1:
        poly = max(polys, key=lambda p: p.area)
        print(f"Warning: multiple polygons found in area GeoJSON ({len(polys)}); selecting largest polygon ({poly.area:.6f})")
    else:
        poly = polys[0]

    if not poly.is_valid:
        from shapely.validation import make_valid
        repaired = make_valid(poly)
        if repaired.is_empty:
            raise ValueError(f"Area polygon is not valid: {explain_validity(poly)}")
        if isinstance(repaired, Polygon):
            print(f"Warning: repaired invalid polygon geometry using make_valid: {poly.geom_type} -> {repaired.geom_type}")
            poly = repaired
        elif hasattr(repaired, "geoms"):
            cand_polys = [g for g in repaired.geoms if isinstance(g, Polygon) and not g.is_empty]
            if cand_polys:
                poly = max(cand_polys, key=lambda p: p.area)
                print(f"Warning: repaired invalid polygon geometry using make_valid (extracted largest Polygon from {repaired.geom_type})")
            else:
                raise ValueError("Area polygon is not valid and could not be repaired to a Polygon")
        else:
            raise ValueError(f"Area polygon is not valid: {explain_validity(poly)}")

    # Check for invalid EPSG:4326 range or swapped lat/lon
    for x, y in poly.exterior.coords:
        if abs(x) > 180 or abs(y) > 90:
            raise ValueError(f"Coordinates out of range for EPSG:4326: ({x}, {y})")

    if any(abs(y) > 90 for x, y in poly.exterior.coords) and all(abs(x) <= 90 for x, y in poly.exterior.coords):
        raise ValueError("Coordinates appear to be in (lat, lon) order; GeoJSON requires (lon, lat)")

    # Demo region sanity check (lat in x position ~28, lon in y position ~77)
    if all(15 <= x <= 35 and 65 <= y <= 85 for x, y in poly.exterior.coords):
        raise ValueError("Coordinates appear to be in (lat, lon) order; GeoJSON requires (lon, lat)")

    # Simplify to <= 100 vertices if larger with printed warning
    if len(poly.exterior.coords) > 100:
        print(f"Warning: polygon has {len(poly.exterior.coords)} vertices, simplifying to <= 100 vertices")
        tol = 0.0001
        while len(poly.exterior.coords) > 100 and tol < 0.1:
            simplified = poly.simplify(tol, preserve_topology=True)
            if isinstance(simplified, Polygon) and simplified.is_valid and not simplified.is_empty:
                poly = simplified
            tol *= 1.5

    return Area(poly, buffer_m=buffer_m, raw_geojson=data, source_path=source_path, source_mtime=source_mtime)


def load_config() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    poly_rel = cfg.get("area_polygon")
    if poly_rel:
        poly_path = (BACKEND / poly_rel).resolve()
        if not poly_path.exists():
            poly_path = (ROOT / poly_rel).resolve()
        if not poly_path.exists():
            raise FileNotFoundError(
                f"Configured area_polygon file '{poly_rel}' was not found at {poly_path}. "
                "Silent fallback to circle is not permitted when area_polygon is configured."
            )
        area = load_area(poly_path, buffer_m=cfg.get("area_buffer_m", 300))
        cfg["center"] = area.centroid
        cfg["radius_m"] = round(area.max_distance_to_vertex(), 1)
        cfg["_area"] = area
    return cfg


CFG = load_config()
DATA = (BACKEND / CFG["data_dir"]).resolve()
RAW = DATA / "raw"
DATA.mkdir(parents=True, exist_ok=True)
RAW.mkdir(parents=True, exist_ok=True)


def get_area() -> Area | None:
    return CFG.get("_area")


def get_earthdata_token() -> str | None:
    if "EARTHDATA_TOKEN" in os.environ and os.environ["EARTHDATA_TOKEN"].strip():
        return os.environ["EARTHDATA_TOKEN"].strip()
    for env_path in [ROOT / ".env", BACKEND / ".env"]:
        if env_path.exists():
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("EARTHDATA_TOKEN="):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if val:
                        return val
    return None


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def write_json(path: Path, obj, compress: bool = False) -> None:
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    if compress:
        with gzip.open(path, "wt", encoding="utf-8") as f:
            f.write(text)
    else:
        path.write_text(text, encoding="utf-8")
    print(f"  wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1024:.0f} KB)")


def read_json(path: Path):
    if str(path).endswith(".gz"):
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    return json.loads(path.read_text(encoding="utf-8"))


_last_request = 0.0


def overpass(query: str, cache_name: str, force: bool = False) -> dict:
    """POST an Overpass query with fair-use behaviour: identifying UA, >=1 s
    between requests, exponential backoff, mirror fallback, disk cache."""
    import httpx

    global _last_request
    cache = RAW / cache_name
    if cache.exists() and not force:
        print(f"  using cached {cache.relative_to(ROOT)}")
        return json.loads(cache.read_text(encoding="utf-8"))

    headers = {"User-Agent": CFG["user_agent"]}
    last_err = None
    for attempt in range(6):
        url = CFG["overpass_urls"][attempt % len(CFG["overpass_urls"])]
        wait = max(0.0, 1.0 - (time.time() - _last_request))
        time.sleep(wait)
        try:
            print(f"  overpass -> {url} (attempt {attempt + 1})")
            _last_request = time.time()
            r = httpx.post(url, data={"data": query}, headers=headers, timeout=180)
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                data = r.json()
                cache.write_text(json.dumps(data), encoding="utf-8")
                return data
            last_err = f"HTTP {r.status_code}: {r.text[:120]}"
        except Exception as e:  # network errors, timeouts
            last_err = repr(e)
        backoff = min(60, 2 ** attempt * 2)
        print(f"    failed ({last_err}); backing off {backoff}s")
        time.sleep(backoff)
    sys.exit(f"Overpass failed after retries: {last_err}")


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))

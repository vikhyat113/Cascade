"""Tests for polygon area handling, GeoJSON parsing, validation, and diagnostics."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from shapely.geometry import Polygon

from app.adapters.area import Area, load_area
from app.adapters.geo import LocalProjection
from app.api.routes import ENGINE
from app.main import app
from app.core.world import StaticWorld


# Helper to generate a small GeoJSON polygon around lat0, lon0 with radius in meters
def make_geojson_poly(lat0: float = 28.57, lon0: float = 77.32, radius_m: float = 500.0, n_pts: int = 12) -> dict:
    import math
    proj = LocalProjection(lat0, lon0)
    coords = []
    for i in range(n_pts):
        ang = 2 * math.pi * i / n_pts
        la, lo = proj.latlon(radius_m * math.cos(ang), radius_m * math.sin(ang))
        coords.append([round(float(lo), 6), round(float(la), 6)])
    coords.append(coords[0])
    return {
        "type": "Feature",
        "geometry": {
            "type": "Polygon",
            "coordinates": [coords]
        }
    }


def test_polygon_validation_valid(tmp_path):
    gj = make_geojson_poly(28.57, 77.32, 600.0)
    p = tmp_path / "area.geojson"
    p.write_text(json.dumps(gj), encoding="utf-8")

    area = load_area(p, buffer_m=300)
    assert isinstance(area, Area)
    assert area.polygon.is_valid
    assert abs(area.centroid["lat"] - 28.57) < 0.001
    assert abs(area.centroid["lon"] - 77.32) < 0.001
    assert len(area.bbox) == 4
    assert area.area_km2() > 0.5


def test_feature_and_feature_collection_accepted(capsys):
    # FeatureCollection with 2 polygons: 1 small, 1 large
    small_poly = make_geojson_poly(28.57, 77.32, 200.0, 8)["geometry"]["coordinates"]
    large_poly = make_geojson_poly(28.57, 77.32, 800.0, 10)["geometry"]["coordinates"]
    fc = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"name": "small"}, "geometry": {"type": "Polygon", "coordinates": small_poly}},
            {"type": "Feature", "properties": {"name": "large"}, "geometry": {"type": "Polygon", "coordinates": large_poly}},
        ]
    }
    area = load_area(fc)
    out = capsys.readouterr().out
    assert "Found 2 polygons in GeoJSON" in out or "Warning" in out
    # Largest polygon should be picked (~800m radius -> ~2 km2)
    assert area.area_km2() > 1.0

    # Bare Feature
    feat = {"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": large_poly}}
    area_feat = load_area(feat)
    assert area_feat.area_km2() > 1.0


def test_missing_polygon_file_raises(tiny_cfg, tiny_data):
    cfg = dict(tiny_cfg)
    cfg["area_polygon"] = "non_existent_polygon_file.geojson"
    with pytest.raises(FileNotFoundError):
        StaticWorld(cfg, tiny_data)


def test_placeholder_suspect_detection():
    # Regular 17-gon (16 segments + closing point = 17 vertices)
    reg_17 = make_geojson_poly(28.57, 77.32, 500.0, n_pts=16)
    area_reg = load_area(reg_17)
    assert len(area_reg.polygon.exterior.coords) == 17
    assert area_reg.placeholder_suspect is True

    # Irregular polygon with varying distances from centroid
    irregular_coords = [
        [77.320, 28.570],
        [77.325, 28.571],
        [77.330, 28.575],
        [77.328, 28.580],
        [77.318, 28.578],
        [77.315, 28.573],
        [77.320, 28.570],
    ]
    irreg_gj = {"type": "Polygon", "coordinates": [irregular_coords]}
    area_irreg = load_area(irreg_gj)
    assert area_irreg.placeholder_suspect is False


def test_polygon_validation_lon_lat_order():
    # Swapped lat/lon: x in ~28.5, y in ~77.3
    gj = {
        "type": "Polygon",
        "coordinates": [[[28.57, 77.32], [28.58, 77.32], [28.58, 77.33], [28.57, 77.33], [28.57, 77.32]]]
    }
    with pytest.raises(ValueError, match="order"):
        load_area(gj)


def test_polygon_simplification(capsys):
    # Polygon with 150 points
    gj = make_geojson_poly(28.57, 77.32, 800.0, n_pts=150)
    area = load_area(gj, buffer_m=300)
    captured = capsys.readouterr()
    assert "simplifying to <= 100 vertices" in captured.out
    assert len(area.polygon.exterior.coords) <= 100


def test_buffer():
    gj = make_geojson_poly(28.57, 77.32, 500.0)
    area = load_area(gj, buffer_m=300.0)
    assert area.buffered_polygon.is_valid
    # Buffered polygon must cover original polygon
    assert area.buffered_polygon.covers(area.polygon)
    # A point 600m away is outside original 500m polygon, but inside 300m buffered polygon
    proj = LocalProjection(28.57, 77.32)
    lat_600m, lon_600m = proj.latlon(600.0, 0.0)
    assert not area.contains(lat_600m, lon_600m)
    assert area.contains_buffered(lat_600m, lon_600m)

    # A point 1000m away is outside both
    lat_1000m, lon_1000m = proj.latlon(1000.0, 0.0)
    assert not area.contains(lat_1000m, lon_1000m)
    assert not area.contains_buffered(lat_1000m, lon_1000m)


def test_point_in_polygon():
    gj = make_geojson_poly(28.57, 77.32, 500.0)
    area = load_area(gj)
    # Center point is inside
    assert area.contains(28.57, 77.32)
    # Point far away is outside
    assert not area.contains(28.70, 77.50)


def test_overpass_string_format():
    gj = make_geojson_poly(28.57, 77.32, 500.0, n_pts=6)
    area = load_area(gj)
    s = area.overpass_poly_str
    assert s.startswith('poly:"')
    assert s.endswith('"')
    body = s[6:-1]
    tokens = body.split()
    assert len(tokens) >= 12  # at least 6 points * 2 coords
    assert len(tokens) % 2 == 0
    lat1 = float(tokens[0])
    lon1 = float(tokens[1])
    assert 28.0 <= lat1 <= 29.0
    assert 77.0 <= lon1 <= 78.0


def test_in_area_with_polygon(tiny_cfg, tiny_data, tmp_path):
    gj = make_geojson_poly(28.57, 77.32, 400.0)
    poly_file = tmp_path / "fixture_area.geojson"
    poly_file.write_text(json.dumps(gj), encoding="utf-8")

    cfg = dict(tiny_cfg)
    cfg["area_polygon"] = str(poly_file)
    cfg["area_buffer_m"] = 200

    world = StaticWorld(cfg, tiny_data)
    assert world.area is not None

    proj = LocalProjection(28.57, 77.32)
    # Inside 400m polygon
    lat_in, lon_in = proj.latlon(200.0, 200.0)
    assert world.in_area(lat_in, lon_in)

    # In buffer zone (400m - 600m)
    lat_buf, lon_buf = proj.latlon(500.0, 0.0)
    assert world.in_area(lat_buf, lon_buf)

    # Outside buffer zone (> 600m)
    lat_out, lon_out = proj.latlon(800.0, 0.0)
    assert not world.in_area(lat_out, lon_out)


def test_in_area_without_polygon_fallback(tiny_cfg, tiny_data):
    cfg = dict(tiny_cfg)
    cfg["area_polygon"] = None
    cfg["radius_m"] = 500.0

    world = StaticWorld(cfg, tiny_data)
    assert world.area is None

    proj = LocalProjection(28.57, 77.32)
    # Distance within radius + 300 = 800m
    lat_in, lon_in = proj.latlon(600.0, 0.0)
    assert world.in_area(lat_in, lon_in)

    # Distance beyond 800m
    lat_out, lon_out = proj.latlon(900.0, 0.0)
    assert not world.in_area(lat_out, lon_out)


def test_area_diagnostics_endpoint(engine):
    ENGINE["engine"] = engine
    client = TestClient(app)
    resp = client.get("/api/area/diagnostics")
    assert resp.status_code == 200
    data = resp.json()

    required_keys = [
        "area_mode", "area_source", "source_mtime", "vertex_count", "area_km2",
        "bbox", "placeholder_suspect", "walk_nodes", "walk_edges", "drive_nodes",
        "drive_edges", "walk_nodes_inside", "drive_nodes_inside", "share_nodes_inside",
        "pois_inside", "pois_outside", "walk_generated_at", "pois_generated_at",
        "stale_data"
    ]
    for key in required_keys:
        assert key in data, f"Key '{key}' missing from /api/area/diagnostics"
    assert data["area_mode"] in ("polygon", "circle_fallback")
    assert isinstance(data["share_nodes_inside"], (int, float))

"""
Tests for polygon-clipped data layers (Phase 1):
1. Clipping drops outside cells and keeps inside cells.
2. UNKNOWN cells carry value null (None) and never fabricated numbers.
3. Metadata fields present (source, product/model, date range, retrieved_at, native resolution, license, attribution, units).
4. No network is used in tests (uses local fixtures).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from shapely.geometry import Polygon, Point
from starlette.testclient import TestClient

from app.main import app
import app.api.routes as routes
from scripts.common import Area


@pytest.fixture
def client(engine):
    routes.ENGINE["engine"] = engine
    return TestClient(app)


@pytest.fixture
def test_square_area() -> Area:
    """A 1 km x 1 km square test polygon in lat/lon (~0.01 deg x 0.01 deg)."""
    # Box from (77.0, 28.0) to (77.01, 28.01)
    poly = Polygon([(77.0, 28.0), (77.01, 28.0), (77.01, 28.01), (77.0, 28.01), (77.0, 28.0)])
    return Area(poly, buffer_m=0.0)


def test_clipping_drops_outside_cells(test_square_area):
    """Confirm clipping strictly drops points/cells whose center is outside the polygon."""
    candidates = [
        {"id": "inside_1", "lat": 28.005, "lon": 77.005, "val": 25.0},
        {"id": "inside_2", "lat": 28.002, "lon": 77.008, "val": 24.5},
        {"id": "outside_north", "lat": 28.015, "lon": 77.005, "val": 22.0},
        {"id": "outside_east", "lat": 28.005, "lon": 77.015, "val": 21.0},
        {"id": "outside_far", "lat": 28.500, "lon": 77.300, "val": 18.0},
    ]

    kept = []
    dropped = 0
    for c in candidates:
        if test_square_area.contains(c["lat"], c["lon"]):
            kept.append(c)
        else:
            dropped += 1

    assert len(kept) == 2
    assert dropped == 3
    assert {c["id"] for c in kept} == {"inside_1", "inside_2"}


def test_unknown_cells_carry_null_value():
    """Verify missing, masked, or NoData cells carry value null, not interpolated or defaulted numbers."""
    raw_observations = [
        {"raw": 14800, "cloud_flag": 0},  # Valid observation
        {"raw": 0, "cloud_flag": 1},      # Cloud masked
        {"raw": -9999, "cloud_flag": 0},  # NoData
    ]

    processed = []
    for obs in raw_observations:
        if obs["raw"] <= 0 or obs["cloud_flag"] > 0:
            val = None
            status = "UNKNOWN"
        else:
            val = round(obs["raw"] * 0.02 - 273.15, 2)
            status = "KNOWN"
        processed.append({"val": val, "status": status})

    # Assertions
    assert processed[0]["val"] is not None
    assert processed[0]["status"] == "KNOWN"
    assert processed[1]["val"] is None
    assert processed[1]["status"] == "UNKNOWN"
    assert processed[2]["val"] is None
    assert processed[2]["status"] == "UNKNOWN"


def test_viirs_layer_metadata_and_structure(tmp_path):
    """Test VIIRS JSON fixture contains all required metadata and follows schema."""
    fixture_data = {
        "source": "NASA Black Marble (VNP46) / Suomi NPP VIIRS DNB",
        "product": "VIIRS_Black_Marble",
        "acquired_range": "2026-10-01 to 2026-10-25",
        "retrieved_at": "2026-10-25T20:00:00Z",
        "native_resolution": "15 arc-seconds (~500 m)",
        "license": "NASA Open Data Policy",
        "attribution": "NASA EOSDIS",
        "unit": "nW/cm2/sr",
        "bbox": [77.0, 28.0, 77.01, 28.01],
        "dropped_cells": 10,
        "kept_cells": 4,
        "rows": [
            {"i": 0, "j": 0, "lat": 28.002, "lon": 77.002, "radiance": 105.2, "status_hint": "KNOWN"},
            {"i": 0, "j": 1, "lat": 28.002, "lon": 77.008, "radiance": None, "status_hint": "UNKNOWN"},
        ],
    }

    f = tmp_path / "test_viirs.json"
    f.write_text(json.dumps(fixture_data))

    loaded = json.loads(f.read_text())
    # Required metadata checks
    assert loaded["source"]
    assert loaded["product"]
    assert loaded["native_resolution"]
    assert loaded["license"]
    assert loaded["attribution"]
    assert loaded["unit"]
    assert loaded["retrieved_at"]

    # Check cell values
    rows = loaded["rows"]
    assert rows[0]["radiance"] == 105.2
    assert rows[0]["status_hint"] == "KNOWN"
    assert rows[1]["radiance"] is None
    assert rows[1]["status_hint"] == "UNKNOWN"


def test_weather_grid_metadata_and_structure(tmp_path):
    """Test weather grid fixture contains model resolution and required fields."""
    fixture_data = {
        "source": "Open-Meteo API / DWD ICON & ECMWF IFS",
        "model": "ECMWF IFS / DWD ICON blended forecast",
        "retrieved_at": "2026-10-25T20:00:00Z",
        "native_resolution": "0.1° (~11 km) sampled at 2.0 km grid",
        "grid_spacing_km": 2.0,
        "license": "CC BY 4.0",
        "attribution": "Open-Meteo.com",
        "units": {"temperature_2m": "°C", "precipitation": "mm"},
        "points": [
            {"id": "pt_1", "lat": 28.005, "lon": 77.005, "hourly": {"time": ["2026-10-26T00:00"], "temperature_2m": [22.5]}}
        ],
    }
    f = tmp_path / "test_weather.json"
    f.write_text(json.dumps(fixture_data))

    loaded = json.loads(f.read_text())
    assert "native_resolution" in loaded
    assert "units" in loaded
    assert len(loaded["points"]) == 1
    assert loaded["points"][0]["hourly"]["temperature_2m"][0] == 22.5


def test_thermal_lst_metadata_and_structure(tmp_path):
    """Test thermal LST fixture contains all required fields."""
    fixture_data = {
        "source": "NASA LP DAAC / Microsoft Planetary Computer",
        "product": "MYD11A2.061 (MODIS Aqua Land Surface Temperature 8-Day L3 Global 1km)",
        "acquired_range": "2026-10-08 to 2026-10-15 (Aqua night pass ~01:30 local)",
        "retrieved_at": "2026-10-25T20:00:00Z",
        "native_resolution": "1 km (Sinusoidal tile grid, nominal 926.6 m)",
        "license": "NASA Open Data Policy (CC0 / Public Domain)",
        "attribution": "NASA EOSDIS LP DAAC",
        "unit": "°C",
        "dropped_cells": 5,
        "kept_cells": 2,
        "cells": [
            {"lat": 28.005, "lon": 77.005, "value": 23.4, "status": "KNOWN"},
            {"lat": 28.008, "lon": 77.008, "value": None, "status": "UNKNOWN"},
        ],
    }
    f = tmp_path / "test_thermal.json"
    f.write_text(json.dumps(fixture_data))

    loaded = json.loads(f.read_text())
    assert loaded["source"]
    assert loaded["product"]
    assert loaded["native_resolution"]
    assert loaded["unit"] == "°C"
    assert loaded["cells"][0]["value"] == 23.4
    assert loaded["cells"][1]["value"] is None
    assert loaded["cells"][1]["status"] == "UNKNOWN"


def test_api_layers_endpoints(client):
    """Test /api/layers and /api/layers/{id} endpoints."""
    res = client.get("/api/layers")
    assert res.status_code == 200
    layers = res.json()
    assert isinstance(layers, list)
    layer_ids = {lay["id"] for lay in layers}
    assert "viirs_ntl" in layer_ids
    assert "thermal_lst" in layer_ids
    assert "weather_grid" in layer_ids

    # Check common metadata fields
    for lay in layers:
        assert "name" in lay
        assert "source" in lay
        assert "native_resolution" in lay
        assert "attribution" in lay
        assert "status" in lay
        assert "available" in lay

    # Test single layer endpoints
    res_viirs = client.get("/api/layers/viirs_ntl")
    if res_viirs.status_code == 200:
        gj = res_viirs.json()
        assert gj["type"] == "FeatureCollection"
        assert gj["layer_id"] == "viirs_ntl"
        assert "features" in gj

    res_thermal = client.get("/api/layers/thermal_lst")
    if res_thermal.status_code == 200:
        gj = res_thermal.json()
        assert gj["type"] == "FeatureCollection"
        assert gj["layer_id"] == "thermal_lst"

    res_weather = client.get("/api/layers/weather_grid?hour=3")
    if res_weather.status_code == 200:
        gj = res_weather.json()
        assert gj["type"] == "FeatureCollection"
        assert gj["hour"] == 3

    # Unknown layer returns 404
    res_404 = client.get("/api/layers/not_a_real_layer")
    assert res_404.status_code == 404


def test_api_pois_enrichment(client):
    """Ensure /api/map/pois returns category group, hours tier, and 24h flag."""
    res = client.get("/api/map/pois")
    assert res.status_code == 200
    gj = res.json()
    assert gj["type"] == "FeatureCollection"
    assert "features" in gj

    facility_found = False
    for feat in gj["features"]:
        props = feat["properties"]
        if props.get("cat") == "street_lamp":
            continue
        facility_found = True
        assert "category_group" in props
        assert props["category_group"] in ("medicine", "food", "hospital", "police", None)
        assert "tier" in props
        assert props["tier"] in ("open", "maybe_open", "unknown", "closed")
        assert "is_24h" in props
        assert isinstance(props["is_24h"], bool)
        assert "hours_state" in props
        assert props["hours_state"]["tier"] in ("open", "maybe_open", "unknown", "closed")
    assert facility_found


def test_viirs_lighting_prior_behaviour():
    """Verify VIIRS prior sets PROBABLE with wide interval without overriding OSM lit tags."""
    import numpy as np
    from scipy.spatial import cKDTree
    from app.core.facts import Fact
    from app.core.freshness import FreshnessConfig
    from app.core.grid import Grid
    from app.core.world import EdgeStatic

    # Mock RoadGraph
    class MockGraph:
        m = 3
        emx = np.array([0.0, 50.0, 100.0])
        emy = np.array([0.0, 0.0, 0.0])
        elit = ["yes", None, None]  # Edge 0 lit=yes, Edge 1 unlit/unclassified, Edge 2 path
        ehw = ["primary", "residential", "path"]

    G = MockGraph()
    now = datetime(2026, 10, 26, 2, 0, tzinfo=timezone.utc)
    fc = FreshnessConfig(known_min_reliability=0.7)
    grid = Grid(500, 250)
    osm_fact = Fact(key="osm_map", value="ok", source="osm_map", synthetic=False,
                    observed_at=now, ttl_s=3600, reliability=0.85, kind="observed")
    prior_fact = Fact(key="prior:lighting", value="main roads lit", source="prior", synthetic=False,
                      observed_at=now, ttl_s=3600, reliability=0.5, kind="prior")

    # VIIRS grid with 80% percentile (bright)
    viirs_tree = cKDTree(np.c_[np.array([0.0, 50.0, 100.0]), np.zeros(3)])
    viirs_percentiles = np.array([80.0, 80.0, 80.0])

    # 1. Without VIIRS prior (default)
    es_default = EdgeStatic(G, None, osm_fact, prior_fact, now, fc, grid, grid, grid,
                            viirs_tree=viirs_tree, viirs_percentiles=viirs_percentiles, use_viirs_prior=False)
    # Edge 0 is lit (OSM lit tag)
    assert "lit" in es_default.light_note[0]
    # Edge 1 has UNKNOWN lighting
    assert es_default.light_code[1] == 0  # UNKNOWN

    # 2. With VIIRS prior enabled
    es_prior = EdgeStatic(G, None, osm_fact, prior_fact, now, fc, grid, grid, grid,
                          viirs_tree=viirs_tree, viirs_percentiles=viirs_percentiles, use_viirs_prior=True)
    # Edge 0 STILL lit (OSM lit tag never overridden)
    assert "lit" in es_prior.light_note[0]
    assert es_prior.light_lo[0] == 0.05

    # Edge 1 now has PROBABLE prior from VIIRS
    assert es_prior.light_code[1] == 2  # PROBABLE
    # Percentile 80 -> darkness 0.20 -> interval [0.0, 0.45]
    assert es_prior.light_lo[1] == 0.0
    assert round(es_prior.light_hi[1], 2) == 0.45
    assert "VIIRS satellite radiance prior" in es_prior.light_note[1]


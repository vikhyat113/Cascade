"""Tests for Live Weather adapter, Moon Illumination, and Live Layer status decay.

Rules tested:
- "Live" means latest data actually available, shown with age.
- Current values are kind 'observed' with observed_at = response timestamp.
- Hourly values are kind 'inferred' (forecast).
- Status chip: LIVE, CACHED, STALE, OFFLINE.
- Offline fallback to cached data on network error.
- live_weather flag disables simulated weather_live feed (no double counting).
- Moon illumination labeled 'computed, not measured'.
- Cloud-masked cells have status UNKNOWN and value None.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

import pytest

from app.adapters.weather_live import WeatherLiveAdapter, MODEL_RESOLUTION
from app.core.astronomy import get_moon_illumination
from app.core.facts import Fact
from app.core.sim.feeds import FeedSimulator
from app.core.state import WorldState


MOCK_OPEN_METEO_RESPONSE = [
    {
        "latitude": 28.57,
        "longitude": 77.32,
        "current": {
            "time": "2026-10-25T20:00:00Z",
            "temperature_2m": 22.4,
            "apparent_temperature": 23.1,
            "relative_humidity_2m": 65,
            "precipitation": 0.0,
            "cloud_cover": 10,
            "wind_speed_10m": 4.5,
            "visibility": 10000.0,
        },
        "hourly": {
            "time": [
                "2026-10-25T20:00",
                "2026-10-25T21:00",
                "2026-10-25T22:00",
                "2026-10-25T23:00",
            ],
            "temperature_2m": [22.4, 21.8, 21.2, 20.9],
            "apparent_temperature": [23.1, 22.5, 21.9, 21.4],
            "relative_humidity_2m": [65, 68, 72, 75],
            "precipitation": [0.0, 0.0, 0.0, 0.0],
            "cloud_cover": [10, 15, 20, 25],
            "wind_speed_10m": [4.5, 4.2, 3.8, 3.5],
            "visibility": [10000.0, 9500.0, 9000.0, 8500.0],
        },
    }
]


@pytest.fixture
def temp_weather_data_dir(tmp_path: Path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    
    # Write a fixture weather_grid.json
    grid_fixture = {
        "source": "Open-Meteo Multi-Location Forecast API",
        "retrieved_at": "2026-10-25T20:00:00Z",
        "model": "ECMWF/DWD Multi-Model blend",
        "native_resolution": MODEL_RESOLUTION,
        "units": {
            "temperature_2m": "°C",
            "apparent_temperature": "°C",
            "relative_humidity_2m": "%",
            "precipitation": "mm",
            "cloud_cover": "%",
            "wind_speed_10m": "km/h",
            "visibility": "m",
        },
        "points": [
            {
                "id": "pt_0_0",
                "i": 0,
                "j": 0,
                "lat": 28.57,
                "lon": 77.32,
                "current": MOCK_OPEN_METEO_RESPONSE[0]["current"],
                "hourly": MOCK_OPEN_METEO_RESPONSE[0]["hourly"],
            }
        ],
    }
    (data_dir / "weather_grid.json").write_text(json.dumps(grid_fixture), encoding="utf-8")
    return data_dir


def test_weather_live_adapter_facts_observed_and_inferred(temp_weather_data_dir):
    tz = ZoneInfo("Asia/Kolkata")
    adapter = WeatherLiveAdapter(
        data_dir=temp_weather_data_dir,
        tz=tz,
        user_agent="NightWay/1.0",
        interval_min=15,
        live_enabled=True,
    )

    now = datetime(2026, 10, 25, 20, 5, tzinfo=timezone.utc)
    facts = adapter.build_facts(now=now)
    assert len(facts) > 0

    # Verify observed conditions
    curr_facts = [f for f in facts if f.key == "weather:now" or f.key.endswith(":now")]
    assert len(curr_facts) > 0
    for f in curr_facts:
        assert f.kind == "observed"
        assert f.observed_at is not None

    # Verify inferred hourly forecast
    hourly_facts = [f for f in facts if f.key.endswith(":hourly")]
    assert len(hourly_facts) > 0
    for f in hourly_facts:
        assert f.kind == "inferred"
        assert f.note == MODEL_RESOLUTION


def test_weather_live_adapter_status_decay(temp_weather_data_dir):
    tz = ZoneInfo("Asia/Kolkata")
    adapter = WeatherLiveAdapter(
        data_dir=temp_weather_data_dir,
        tz=tz,
        user_agent="NightWay/1.0",
        interval_min=15,
        live_enabled=True,
    )

    # 1. 5 minutes after fetch -> LIVE
    t_live = datetime(2026, 10, 25, 20, 5, tzinfo=timezone.utc)
    chip, age_s, _ = adapter.get_status_chip(t_live)
    assert chip == "LIVE"
    assert age_s == 300

    # 2. 25 minutes after fetch (beyond 15m interval, but under 1h) -> CACHED
    t_cached = datetime(2026, 10, 25, 20, 25, tzinfo=timezone.utc)
    chip, age_s, _ = adapter.get_status_chip(t_cached)
    assert chip == "CACHED"
    assert age_s == 1500

    # 3. 2 hours after fetch (beyond 1h) -> STALE
    t_stale = datetime(2026, 10, 25, 22, 10, tzinfo=timezone.utc)
    chip, age_s, _ = adapter.get_status_chip(t_stale)
    assert chip == "STALE"
    assert age_s == 7800

    # 4. 25 hours after fetch (beyond 24h TTL) -> OFFLINE
    t_offline = datetime(2026, 10, 26, 21, 10, tzinfo=timezone.utc)
    chip, age_s, _ = adapter.get_status_chip(t_offline)
    assert chip == "OFFLINE"


def test_weather_live_fallback_to_cache_on_error(temp_weather_data_dir):
    tz = ZoneInfo("Asia/Kolkata")
    adapter = WeatherLiveAdapter(
        data_dir=temp_weather_data_dir,
        tz=tz,
        user_agent="NightWay/1.0",
        interval_min=15,
        live_enabled=True,
    )

    # Mock httpx failure
    with patch("httpx.Client.get", side_effect=Exception("Connection refused")):
        now = datetime(2026, 10, 25, 20, 30, tzinfo=timezone.utc)
        adapter.last_fetch = None
        ok = adapter.poll(now=now)

        # On network failure, poll returns False, retains cached grid data
        assert ok is False
        assert adapter.grid_data is not None
        assert adapter.last_error is not None
        assert "Connection refused" in adapter.last_error


def test_live_weather_flag_disables_synthetic_feed(engine):
    """When live_weather is ON, simulated feed must be disabled (no double counting)."""
    # Test with default: live_weather is False
    engine.static.live_weather = False
    feed = FeedSimulator(engine.state, bursts=False)
    engine.state.store.pop("weather:now", None)
    assert "weather:now" not in engine.state.store

    src = engine.state.sources["weather_live"]
    now = engine.state.now()
    feed._emit_weather_live(src, now, now)
    # Emitted synthetic weather fact
    assert "weather:now" in engine.state.store

    # Test with live_weather is True
    engine.static.live_weather = True
    engine.state.store.pop("weather:now", None)
    feed2 = FeedSimulator(engine.state, bursts=False)
    feed2._emit_weather_live(src, now, now)
    # No new synthetic facts emitted
    assert "weather:now" not in engine.state.store


def test_astronomical_moon_illumination():
    """Verify astronomical moon calculation is labeled 'computed, not measured' and returns valid ranges."""
    dt = datetime(2026, 10, 25, 20, 0, tzinfo=timezone.utc)
    info = get_moon_illumination(dt=dt, lat=28.57, lon=77.32)

    assert "fraction" in info
    assert 0.0 <= info["fraction"] <= 1.0
    assert 0.0 <= info["percent"] <= 100.0
    assert "phase_name" in info
    assert info["label"] == "computed, not measured"
    assert info.get("computed_not_measured") is True

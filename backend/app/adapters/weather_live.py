"""Open-Meteo multi-location live weather adapter for NightWay.

Polls Open-Meteo for the polygon's 2km grid points for current conditions
and 48h hourly forecast. Respects rate limits, caching, and polite client policies.
Converts responses into Facts (current = observed, hourly = inferred).
"""
from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional
from zoneinfo import ZoneInfo

import httpx

from ..core.facts import Fact

logger = logging.getLogger(__name__)

OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
MODEL_RESOLUTION = "0.1° (~11 km) native ECMWF/DWD model resolution, sampled on 2.0 km grid"


class WeatherLiveAdapter:
    def __init__(
        self,
        data_dir: Path,
        tz: ZoneInfo,
        user_agent: str,
        interval_min: int = 15,
        live_enabled: bool = False,
    ):
        self.data_dir = data_dir
        self.grid_file = data_dir / "weather_grid.json"
        self.tz = tz
        self.user_agent = user_agent
        self.interval_min = interval_min
        self.live_enabled = live_enabled

        self.last_fetch: Optional[datetime] = None
        self.last_attempt: Optional[datetime] = None
        self.last_error: Optional[str] = None
        self.grid_data: Optional[dict[str, Any]] = None
        self.on_update: list[Callable[[dict[str, Any]], None]] = []

        # Load existing cache from disk
        self.load_cache()

    def load_cache(self) -> bool:
        """Load cached weather_grid.json from disk."""
        if not self.grid_file.exists():
            return False
        try:
            content = self.grid_file.read_text(encoding="utf-8")
            data = json.loads(content)
            self.grid_data = data
            retrieved_at_str = data.get("retrieved_at")
            if retrieved_at_str:
                self.last_fetch = datetime.fromisoformat(retrieved_at_str.replace("Z", "+00:00"))
            return True
        except Exception as e:
            logger.warning("Failed to load weather_grid.json: %s", e)
            self.grid_data = None
            return False

    def get_grid_points(self) -> list[tuple[float, float, str]]:
        """Return list of (lat, lon, id) for all grid cells."""
        if self.grid_data and "points" in self.grid_data:
            return [(float(p["lat"]), float(p["lon"]), p.get("id", f"grid_{i}")) for i, p in enumerate(self.grid_data["points"])]
        return [(28.5705, 77.3229, "grid_0")]

    def should_poll(self, now: Optional[datetime] = None) -> bool:
        """Check if enough time has elapsed to poll Open-Meteo again."""
        if not self.live_enabled:
            return False
        if self.last_fetch is None:
            return True
        now = now or datetime.now(timezone.utc)
        elapsed_s = (now - self.last_fetch).total_seconds()
        return elapsed_s >= (self.interval_min * 60)

    def poll(
        self,
        now: Optional[datetime] = None,
        points: Optional[list[tuple[float, float, str]]] = None,
        client: Optional[httpx.Client] = None,
    ) -> bool:
        """Poll Open-Meteo multi-location forecast API for current + hourly values."""
        if points is None:
            points = self.get_grid_points()
        if not points:
            return False

        lats = [str(p[0]) for p in points]
        lons = [str(p[1]) for p in points]

        params = {
            "latitude": ",".join(lats),
            "longitude": ",".join(lons),
            "current": "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,cloud_cover,wind_speed_10m",
            "hourly": "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,cloud_cover,wind_speed_10m,visibility",
            "timezone": str(self.tz),
            "forecast_days": 2,
        }
        headers = {"User-Agent": self.user_agent}

        self.last_attempt = datetime.now(timezone.utc)
        try:
            if client is not None:
                r = client.get(OPEN_METEO_FORECAST_URL, params=params, headers=headers, timeout=25.0)
            else:
                with httpx.Client(timeout=25.0) as http:
                    r = http.get(OPEN_METEO_FORECAST_URL, params=params, headers=headers)
            r.raise_for_status()
            raw_res = r.json()
        except Exception as e:
            self.last_error = str(e)
            logger.warning("Open-Meteo live poll failed (%s). Keeping cached response.", e)
            return False

        if isinstance(raw_res, dict):
            raw_res = [raw_res]

        now_utc = datetime.now(timezone.utc)
        self.last_fetch = now_utc
        self.last_error = None

        # Build updated grid_data structure
        updated_points = []
        for idx, (res, (la, lo, pid)) in enumerate(zip(raw_res, points)):
            cur = res.get("current", {})
            hly = res.get("hourly", {})
            updated_points.append({
                "id": pid,
                "lat": la,
                "lon": lo,
                "current": {
                    "time": cur.get("time"),
                    "temperature_2m": cur.get("temperature_2m"),
                    "apparent_temperature": cur.get("apparent_temperature"),
                    "relative_humidity_2m": cur.get("relative_humidity_2m"),
                    "precipitation": cur.get("precipitation", 0.0),
                    "cloud_cover": cur.get("cloud_cover"),
                    "wind_speed_10m": cur.get("wind_speed_10m"),
                },
                "hourly": {
                    "time": hly.get("time", []),
                    "temperature_2m": hly.get("temperature_2m", []),
                    "apparent_temperature": hly.get("apparent_temperature", []),
                    "relative_humidity_2m": hly.get("relative_humidity_2m", []),
                    "precipitation": hly.get("precipitation", []),
                    "cloud_cover": hly.get("cloud_cover", []),
                    "wind_speed_10m": hly.get("wind_speed_10m", []),
                    "visibility": hly.get("visibility", []),
                },
            })

        times = updated_points[0]["hourly"]["time"] if updated_points and "hourly" in updated_points[0] else []
        date_range_str = f"{times[0]} to {times[-1]}" if times else "N/A"

        out_data = {
            "source": "Open-Meteo API / DWD ICON & ECMWF IFS",
            "model": "ECMWF IFS / DWD ICON blended forecast",
            "retrieved_at": now_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "grid_spacing_km": 2.0,
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
            "date_range": date_range_str,
            "points": updated_points,
            "live": True,
            "attribution": "Weather data by Open-Meteo.com (CC BY 4.0)",
            "license": "CC BY 4.0",
        }

        self.grid_data = out_data

        # Cache to disk
        try:
            self.grid_file.write_text(json.dumps(out_data, indent=2), encoding="utf-8")
        except Exception as e:
            logger.warning("Failed to write weather_grid.json: %s", e)

        # Notify subscribers
        for cb in self.on_update:
            try:
                cb(out_data)
            except Exception as e:
                logger.error("Error in weather update callback: %s", e)

        return True

    def build_facts(self, now: Optional[datetime] = None) -> list[Fact]:
        """Convert current and hourly forecasts into Facts.

        - Current condition is kind 'observed' with observed_at = response timestamp.
        - Hourly conditions are kind 'inferred' (forecast).
        """
        if not self.grid_data or "points" not in self.grid_data:
            return []

        retrieved_at_str = self.grid_data.get("retrieved_at")
        obs_dt = (
            datetime.fromisoformat(retrieved_at_str.replace("Z", "+00:00"))
            if retrieved_at_str
            else (now or datetime.now(timezone.utc))
        )

        facts: list[Fact] = []
        points = self.grid_data["points"]

        # City-wide aggregate observation for 'weather:now'
        temps = [p.get("current", {}).get("temperature_2m") for p in points if p.get("current", {}).get("temperature_2m") is not None]
        rains = [p.get("current", {}).get("precipitation") for p in points if p.get("current", {}).get("precipitation") is not None]
        winds = [p.get("current", {}).get("wind_speed_10m") for p in points if p.get("current", {}).get("wind_speed_10m") is not None]

        mean_temp = round(float(sum(temps) / len(temps)), 1) if temps else None
        max_rain = round(float(max(rains)), 2) if rains else 0.0
        mean_wind = round(float(sum(winds) / len(winds)), 1) if winds else None

        city_val = {
            "temp_c": mean_temp,
            "rain_mm": max_rain,
            "rain_class": "none" if max_rain <= 0.05 else ("light" if max_rain < 2.5 else "moderate"),
            "wind_kmh": mean_wind,
            "fog": False,
        }

        # Observed fact for weather:now
        facts.append(
            Fact(
                key="weather:now",
                value=city_val,
                source="weather_live" if self.live_enabled else "weather_forecast",
                synthetic=False,
                observed_at=obs_dt,
                ttl_s=900,
                reliability=0.85,
                kind="observed",
                note=f"real Open-Meteo grid observation ({len(points)} cells)",
            )
        )

        # Per-cell observed & inferred facts
        for p in points:
            pid = p.get("id", "grid_0")
            cur = p.get("current", {})
            cur_time_str = cur.get("time")
            cur_obs_dt = (
                datetime.fromisoformat(cur_time_str).replace(tzinfo=self.tz)
                if cur_time_str
                else obs_dt
            )
            # 1. Observed current fact per cell
            facts.append(
                Fact(
                    key=f"weather:cell:{pid}:now",
                    value=cur,
                    source="weather_grid",
                    synthetic=False,
                    observed_at=cur_obs_dt,
                    ttl_s=900,
                    reliability=0.85,
                    kind="observed",
                )
            )
            # 2. Inferred forecast fact per cell
            hly = p.get("hourly", {})
            facts.append(
                Fact(
                    key=f"weather:cell:{pid}:hourly",
                    value=hly,
                    source="weather_grid",
                    synthetic=False,
                    observed_at=obs_dt,
                    ttl_s=86400,
                    reliability=0.80,
                    kind="inferred",
                    note=MODEL_RESOLUTION,
                )
            )

        return facts

    def get_status_chip(self, now: Optional[datetime] = None) -> tuple[str, Optional[float], str]:
        """Compute status chip: (status_word, age_s, source_label).

        status_word is one of: 'LIVE', 'CACHED', 'STALE', 'OFFLINE'.
        """
        now = now or datetime.now(timezone.utc)
        if self.last_fetch is None:
            return "OFFLINE", None, "Open-Meteo"

        age_s = max(0.0, (now - self.last_fetch).total_seconds())

        if not self.live_enabled:
            # When live is off, it is CACHED while inside validity, else STALE
            status_word = "STALE" if age_s > 86400 else "CACHED"
            return status_word, age_s, "Open-Meteo (cached)"

        # When live is on:
        if age_s <= (self.interval_min * 60 + 60):  # within poll TTL (+ buffer)
            return "LIVE", age_s, "Open-Meteo (live)"
        elif age_s <= 3600:
            return "CACHED", age_s, "Open-Meteo (cached)"
        elif age_s <= 86400:
            return "STALE", age_s, "Open-Meteo (stale)"
        else:
            return "OFFLINE", age_s, "Open-Meteo (offline)"

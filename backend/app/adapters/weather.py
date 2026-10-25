"""Open-Meteo forecast cache (real data) + optional live refresh.

Weather data by Open-Meteo.com (CC BY 4.0). Read from data/weather_cache.json;
`refresh()` re-downloads it when the machine is online (never automatic).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

URL = "https://api.open-meteo.com/v1/forecast"


class WeatherCache:
    def __init__(self, path: Path, tz: ZoneInfo):
        self.path = path
        self.tz = tz
        self.fetched_at: Optional[datetime] = None
        self.hours: dict[datetime, dict] = {}
        self.load()

    def load(self) -> None:
        self.hours = {}
        self.fetched_at = None
        if not self.path.exists():
            return
        try:
            d = json.loads(self.path.read_text(encoding="utf-8"))
            self.fetched_at = datetime.fromisoformat(d["fetched_at"].replace("Z", "+00:00"))
            H = d["hourly"]
            for i, t in enumerate(H["time"]):
                dt = datetime.fromisoformat(t).replace(tzinfo=self.tz)
                self.hours[dt] = {
                    "temp_c": H.get("temperature_2m", [None])[i],
                    "precip_prob": (H.get("precipitation_probability") or [None] * (i + 1))[i],
                    "precip_mm": H.get("precipitation", [None])[i],
                    "rain_mm": H.get("rain", [None])[i],
                    "wind_kmh": H.get("wind_speed_10m", [None])[i],
                    "code": H.get("weather_code", [None])[i],
                    "visibility_m": (H.get("visibility") or [None] * (i + 1))[i],
                }
        except (KeyError, ValueError, TypeError, json.JSONDecodeError):
            self.hours, self.fetched_at = {}, None   # corrupt cache -> behave as missing

    def at(self, t: datetime) -> Optional[dict]:
        key = t.astimezone(self.tz).replace(minute=0, second=0, microsecond=0)
        return self.hours.get(key)

    def refresh(self, lat: float, lon: float, user_agent: str) -> bool:
        import httpx
        params = {
            "latitude": lat, "longitude": lon,
            "hourly": "temperature_2m,precipitation_probability,precipitation,rain,wind_speed_10m,weather_code,visibility",
            "timezone": str(self.tz), "past_days": 1, "forecast_days": 3,
        }
        try:
            r = httpx.get(URL, params=params, headers={"User-Agent": user_agent}, timeout=15)
            r.raise_for_status()
            d = r.json()
        except Exception:
            return False
        d["fetched_at"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
        d["credit"] = "Weather data by Open-Meteo.com (CC BY 4.0)"
        self.path.write_text(json.dumps(d), encoding="utf-8")
        self.load()
        return True


def rain_class(mm_per_h: Optional[float]) -> Optional[str]:
    if mm_per_h is None:
        return None
    if mm_per_h <= 0.05:
        return "none"
    if mm_per_h < 2.5:
        return "light"
    if mm_per_h < 7.6:
        return "moderate"
    return "heavy"


RAIN_MM = {"none": 0.0, "light": 1.0, "moderate": 4.0, "heavy": 12.0}

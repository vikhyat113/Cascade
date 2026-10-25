"""Fetch the hourly Open-Meteo forecast for the demo area and cache it.

    python scripts/fetch_weather.py

Open-Meteo is free for non-commercial use and needs no key. Weather data by
Open-Meteo.com (CC BY 4.0). The backend can also refresh this cache live via
POST /api/weather/refresh when online.
"""
from __future__ import annotations

import httpx

from common import CFG, DATA, utc_now_iso, write_json

URL = "https://api.open-meteo.com/v1/forecast"


def main():
    params = {
        "latitude": CFG["center"]["lat"],
        "longitude": CFG["center"]["lon"],
        "hourly": "temperature_2m,precipitation_probability,precipitation,rain,wind_speed_10m,weather_code,visibility",
        "current": "temperature_2m,precipitation,rain,wind_speed_10m,weather_code",
        "timezone": CFG["timezone"],
        "past_days": 1,
        "forecast_days": 3,
    }
    r = httpx.get(URL, params=params, headers={"User-Agent": CFG["user_agent"]}, timeout=30)
    r.raise_for_status()
    data = r.json()
    data["fetched_at"] = utc_now_iso()
    data["credit"] = "Weather data by Open-Meteo.com (CC BY 4.0)"
    n = len(data.get("hourly", {}).get("time", []))
    print(f"  {n} hourly rows, current={data.get('current')}")
    write_json(DATA / "weather_cache.json", data)


if __name__ == "__main__":
    main()

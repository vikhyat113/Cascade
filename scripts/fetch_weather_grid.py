"""Hourly forecast at points spread over the area zones, for the Weather map layer (UPGRADE §3).
One Open-Meteo request for all points (it takes comma-separated coordinates), no key, cached.

    backend/.venv/Scripts/python scripts/fetch_weather_grid.py
"""
from __future__ import annotations

import math

import httpx
from shapely.geometry import Point

import area
from common import CFG, DATA, utc_now_iso, write_json

URL = "https://api.open-meteo.com/v1/forecast"
SPACING_KM = 3.0


def points() -> list[tuple[float, float]]:
    zones = area.polygons()
    s = min(p.bounds[1] for _, p in zones); n = max(p.bounds[3] for _, p in zones)
    w = min(p.bounds[0] for _, p in zones); e = max(p.bounds[2] for _, p in zones)
    dlat = SPACING_KM / 110.54
    dlon = SPACING_KM / (111.32 * math.cos(math.radians((s + n) / 2)))
    out, lat = [], s + dlat / 2
    while lat < n:
        lon = w + dlon / 2
        while lon < e:
            if any(p.buffer(0.005).contains(Point(lon, lat)) for _, p in zones):
                out.append((round(lat, 4), round(lon, 4)))
            lon += dlon
        lat += dlat
    return out


def main():
    pts = points()
    params = {"latitude": ",".join(str(p[0]) for p in pts), "longitude": ",".join(str(p[1]) for p in pts),
              "hourly": "temperature_2m,precipitation_probability,precipitation,weather_code",
              "timezone": CFG["timezone"], "forecast_days": 3}
    r = httpx.get(URL, params=params, headers={"User-Agent": CFG["user_agent"]}, timeout=60)
    r.raise_for_status()
    data = r.json()
    rows = data if isinstance(data, list) else [data]
    H = rows[0]["hourly"]
    out = {"generated_at": utc_now_iso(), "fetched_at": utc_now_iso(), "source": "Open-Meteo.com forecast (CC BY 4.0), real",
           "spacing_km": SPACING_KM, "time": H["time"],
           "points": [{"lat": p[0], "lon": p[1],
                       "temp": row["hourly"]["temperature_2m"], "rain_prob": row["hourly"]["precipitation_probability"],
                       "rain_mm": row["hourly"]["precipitation"], "code": row["hourly"]["weather_code"]} for p, row in zip(pts, rows)]}
    print(f"  {len(pts)} points, {len(H['time'])} hours")
    write_json(DATA / "weather_grid.json", out)


if __name__ == "__main__":
    main()

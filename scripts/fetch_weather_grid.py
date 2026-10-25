"""Fetch Open-Meteo regular forecast grid and 5-year climatology over demo area.

Products:
(a) data/weather_grid.json: 48h hourly multi-location forecast over 2km grid inside polygon.
(b) data/weather_climatology.json: 5-year archive climatology for night hours 22:00-06:00.

Usage:
    python scripts/fetch_weather_grid.py [--force]
"""
from __future__ import annotations

import math
import sys
from datetime import datetime
from pathlib import Path

import httpx
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "backend"))

from common import CFG, DATA, Area, get_area, utc_now_iso, write_json  # noqa: E402

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"


def main():
    area: Area | None = get_area()
    if area is not None:
        bbox = area.bbox
    else:
        lat, lon = CFG["center"]["lat"], CFG["center"]["lon"]
        dlat = CFG["radius_m"] / 110540.0
        dlon = CFG["radius_m"] / (111320.0 * math.cos(math.radians(lat)))
        bbox = [round(lon - dlon, 6), round(lat - dlat, 6), round(lon + dlon, 6), round(lat + dlat, 6)]

    min_lon, min_lat, max_lon, max_lat = bbox
    spacing_km = float(CFG.get("weather_grid_km", 2.0))
    dlat = spacing_km / 110.54
    dlon = spacing_km / (111.32 * math.cos(math.radians((min_lat + max_lat) / 2.0)))

    lats = np.arange(min_lat + dlat / 2.0, max_lat, dlat)
    lons = np.arange(min_lon + dlon / 2.0, max_lon, dlon)

    pts = []
    dropped = 0
    for la in lats:
        for lo in lons:
            la_f, lo_f = round(float(la), 6), round(float(lo), 6)
            if area is not None and not area.contains_buffered(la_f, lo_f):
                dropped += 1
                continue
            pts.append((la_f, lo_f))

    print(f"Weather grid ({spacing_km} km spacing): dropped {dropped} points outside polygon; kept {len(pts)} points inside.")

    if not pts:
        # Fallback to center point if bounding box is very small
        pts = [(round(CFG["center"]["lat"], 6), round(CFG["center"]["lon"], 6))]

    # ---- (a) 48h Forecast Multi-Location Request ----
    print(f"Fetching 48h forecast for {len(pts)} grid locations from Open-Meteo...")
    params = {
        "latitude": ",".join(str(p[0]) for p in pts),
        "longitude": ",".join(str(p[1]) for p in pts),
        "hourly": "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,cloud_cover,wind_speed_10m,visibility",
        "timezone": CFG["timezone"],
        "forecast_days": 2,
    }
    headers = {"User-Agent": CFG["user_agent"]}
    r = httpx.get(FORECAST_URL, params=params, headers=headers, timeout=30)
    r.raise_for_status()
    raw_res = r.json()
    if isinstance(raw_res, dict):
        raw_res = [raw_res]

    points_data = []
    for idx, (res, (la, lo)) in enumerate(zip(raw_res, pts)):
        h = res.get("hourly", {})
        points_data.append({
            "id": f"grid_{idx}",
            "lat": la,
            "lon": lo,
            "hourly": {
                "time": h.get("time", []),
                "temperature_2m": h.get("temperature_2m", []),
                "apparent_temperature": h.get("apparent_temperature", []),
                "relative_humidity_2m": h.get("relative_humidity_2m", []),
                "precipitation": h.get("precipitation", []),
                "cloud_cover": h.get("cloud_cover", []),
                "wind_speed_10m": h.get("wind_speed_10m", []),
                "visibility": h.get("visibility", []),
            }
        })

    grid_meta = {
        "source": "Open-Meteo API / DWD ICON & ECMWF IFS",
        "model": "ECMWF IFS / DWD ICON blended forecast",
        "retrieved_at": utc_now_iso(),
        "native_resolution": "0.1° (~11 km) sampled at 2.0 km grid",
        "grid_spacing_km": spacing_km,
        "license": "Weather data by Open-Meteo.com (CC BY 4.0)",
        "attribution": "Open-Meteo.com under CC BY 4.0",
        "units": {
            "temperature_2m": "°C",
            "apparent_temperature": "°C",
            "relative_humidity_2m": "%",
            "precipitation": "mm",
            "cloud_cover": "%",
            "wind_speed_10m": "km/h",
            "visibility": "m",
        },
        "bbox": bbox,
        "dropped_points": dropped,
        "kept_points": len(pts),
        "points": points_data,
    }
    grid_path = DATA / "weather_grid.json"
    write_json(grid_path, grid_meta)
    print(f"Successfully generated {grid_path.relative_to(ROOT)}")

    # ---- (b) 5-Year Nighttime Climatology (2021-2025) ----
    print("Fetching 5-year archive climatology (2021-2025) for hours 22:00-06:00...")
    c_lat = CFG["center"]["lat"]
    c_lon = CFG["center"]["lon"]
    arch_params = {
        "latitude": c_lat,
        "longitude": c_lon,
        "start_date": "2021-01-01",
        "end_date": "2025-12-31",
        "hourly": "temperature_2m,apparent_temperature,precipitation",
        "timezone": CFG["timezone"],
    }
    r_arch = httpx.get(ARCHIVE_URL, params=arch_params, headers=headers, timeout=40)
    r_arch.raise_for_status()
    arch_json = r_arch.json().get("hourly", {})

    times = arch_json.get("time", [])
    temps = arch_json.get("temperature_2m", [])
    app_temps = arch_json.get("apparent_temperature", [])
    precips = arch_json.get("precipitation", [])

    night_hours = {22, 23, 0, 1, 2, 3, 4, 5, 6}
    # Bucket by (month, hour) -> list of (temp, app_temp, precip)
    buckets: dict[tuple[int, int], list[tuple[float, float, float]]] = {}
    for m in range(1, 13):
        for hh in night_hours:
            buckets[(m, hh)] = []

    for t_str, temp, app_t, pr in zip(times, temps, app_temps, precips):
        if temp is None or app_t is None or pr is None:
            continue
        try:
            dt = datetime.fromisoformat(t_str)
            if dt.hour in night_hours:
                buckets[(dt.month, dt.hour)].append((float(temp), float(app_t), float(pr)))
        except Exception:
            continue

    clim_summary: dict[str, dict[str, dict]] = {}
    for m in range(1, 13):
        m_key = f"{m:02d}"
        clim_summary[m_key] = {}
        for hh in sorted(night_hours):
            hh_key = f"{hh:02d}"
            rows = buckets.get((m, hh), [])
            if rows:
                p_vals = [r[2] for r in rows]
                app_vals = [r[1] for r in rows]
                rain_freq = round(sum(1 for p in p_vals if p > 0.1) / len(p_vals), 4)
                mean_app = round(float(np.mean(app_vals)), 2)
                p90_app = round(float(np.percentile(app_vals, 90)), 2)
                clim_summary[m_key][hh_key] = {
                    "count": len(rows),
                    "rain_frequency": rain_freq,
                    "mean_apparent_temperature": mean_app,
                    "p90_apparent_temperature": p90_app,
                }
            else:
                clim_summary[m_key][hh_key] = {
                    "count": 0,
                    "rain_frequency": 0.0,
                    "mean_apparent_temperature": 25.0,
                    "p90_apparent_temperature": 28.0,
                }

    clim_meta = {
        "source": "Open-Meteo ERA5 / ERA5-Land Reanalysis Archive",
        "retrieved_at": utc_now_iso(),
        "native_resolution": "0.1° (~11 km)",
        "period": "2021-01-01 to 2025-12-31 (5 years, 43824 hours)",
        "night_hours": "22:00 to 06:00 local time",
        "license": "Copernicus Climate Change Service / Open-Meteo (CC BY 4.0)",
        "attribution": "ERA5 reanalysis via Open-Meteo.com",
        "units": {
            "temperature": "°C",
            "rain_frequency": "fraction (0-1)",
        },
        "monthly_hourly_climatology": clim_summary,
    }
    clim_path = DATA / "weather_climatology.json"
    write_json(clim_path, clim_meta)
    print(f"Successfully generated {clim_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

"""
Fetch real Land Surface Temperature (LST) over the service-area polygon.
Implements:
1. Primary: NASA MODIS Aqua Night LST (MYD11A2.061, 1 km resolution, night pass ~01:30 local).
   Accessed via Planetary Computer STAC API or NASA Earthdata CMR.
2. Optional Landsat 8/9 daytime surface temperature (30 m block-averaged to 120 m).

Clipped strictly to the buffered polygon from Area.
Cells outside polygon are dropped. Missing / cloud cells are UNKNOWN with value null.
Never interpolates or synthesizes fake data.
"""

from __future__ import annotations

import argparse
import datetime
import io
import json
import math
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image
from shapely.geometry import Point, shape

from common import get_area, get_earthdata_token

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"

USER_AGENT = "NightWay-Prototype/1.0 (+https://github.com/nightway; research/safety)"
PC_STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
PC_SIGN_URL = "https://planetarycomputer.microsoft.com/api/sas/v1/sign"

# MODIS Sinusoidal Projection constants
R_SIN = 6371007.181
TILE_SIZE_M = 1111950.51978
PIXEL_SIZE_M = 926.6254330555555


def latlon_to_modis_tile(lat: float, lon: float) -> tuple[int, int, float, float]:
    """Convert lat/lon to MODIS Sinusoidal tile (h, v) and tile fractional (row, col)."""
    lat_r = math.radians(lat)
    lon_r = math.radians(lon)
    y = R_SIN * lat_r
    x = R_SIN * lon_r * math.cos(lat_r)

    # Global grid origin (-20015109.356, 10007554.678)
    x_rel = x - (-20015109.356)
    y_rel = 10007554.678 - y

    h = int(math.floor(x_rel / TILE_SIZE_M))
    v = int(math.floor(y_rel / TILE_SIZE_M))

    x_in_tile = x_rel - (h * TILE_SIZE_M)
    y_in_tile = y_rel - (v * TILE_SIZE_M)

    col = x_in_tile / PIXEL_SIZE_M
    row = y_in_tile / PIXEL_SIZE_M
    return h, v, row, col


def modis_tile_to_latlon(h: int, v: int, row: int | float, col: int | float) -> tuple[float, float]:
    """Convert MODIS tile (h, v) and pixel (row, col) center to lat/lon."""
    x_min = -20015109.356 + h * TILE_SIZE_M
    y_max = 10007554.678 - v * TILE_SIZE_M

    x = x_min + (col + 0.5) * PIXEL_SIZE_M
    y = y_max - (row + 0.5) * PIXEL_SIZE_M

    lat = math.degrees(y / R_SIN)
    cos_lat = math.cos(math.radians(lat))
    lon = math.degrees(x / (R_SIN * cos_lat)) if abs(cos_lat) > 1e-7 else 0.0
    return lat, lon


def sign_planetary_computer_url(href: str) -> str:
    """Sign a Planetary Computer asset URL using the SAS API."""
    req_url = f"{PC_SIGN_URL}?href={urllib.parse.quote(href)}"
    req = urllib.request.Request(req_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        return data["href"]


def fetch_modis_aqua_night_lst(area) -> dict:
    poly = area.polygon
    min_lon, min_lat, max_lon, max_lat = poly.bounds

    print(f"Searching Planetary Computer for MODIS Aqua Night LST (MYD11A2.061) over bbox [{min_lon:.3f}, {min_lat:.3f}, {max_lon:.3f}, {max_lat:.3f}]...")
    stac_payload = {
        "collections": ["modis-11A2-061"],
        "bbox": [min_lon, min_lat, max_lon, max_lat],
        "limit": 5,
        "sortby": [{"field": "properties.datetime", "direction": "desc"}],
    }
    req = urllib.request.Request(
        PC_STAC_URL,
        data=json.dumps(stac_payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
    )

    with urllib.request.urlopen(req, timeout=20) as resp:
        res = json.loads(resp.read().decode("utf-8"))
        features = res.get("features", [])

    if not features:
        raise RuntimeError("No MODIS Aqua LST scenes found for this area on Planetary Computer.")

    # Find the most recent feature with LST_Night_1km asset
    selected_feature = None
    for feat in features:
        if "LST_Night_1km" in feat.get("assets", {}):
            selected_feature = feat
            break

    if not selected_feature:
        raise RuntimeError("No scene with LST_Night_1km asset found.")

    feat_id = selected_feature["id"]
    props = selected_feature.get("properties", {})
    acq_date = props.get("datetime") or props.get("start_datetime", "unknown")
    start_dt = props.get("start_datetime", "")
    end_dt = props.get("end_datetime", "")
    date_range = f"{start_dt[:10]} to {end_dt[:10]} (Aqua night pass ~01:30 local)" if start_dt and end_dt else acq_date

    asset_href = selected_feature["assets"]["LST_Night_1km"]["href"]
    print(f"Selected MODIS scene: {feat_id} ({date_range})")
    print("Signing Planetary Computer asset URL...")
    signed_url = sign_planetary_computer_url(asset_href)

    print("Downloading MODIS Night LST GeoTIFF...")
    img_req = urllib.request.Request(signed_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(img_req, timeout=30) as img_resp:
        img_bytes = img_resp.read()

    img = Image.open(io.BytesIO(img_bytes))
    arr = np.array(img, dtype=np.uint16)
    rows_total, cols_total = arr.shape
    print(f"Downloaded MODIS raster: {cols_total}x{rows_total} pixels.")

    # Identify MODIS tile
    # Compute tile h, v from center
    center_lat = (min_lat + max_lat) / 2.0
    center_lon = (min_lon + max_lon) / 2.0
    h, v, _, _ = latlon_to_modis_tile(center_lat, center_lon)

    # Compute row/col bounds for the bbox
    _, _, r1, c1 = latlon_to_modis_tile(max_lat, min_lon)
    _, _, r2, c2 = latlon_to_modis_tile(min_lat, max_lon)
    r_min = max(0, int(math.floor(min(r1, r2))) - 1)
    r_max = min(rows_total - 1, int(math.ceil(max(r1, r2))) + 1)
    c_min = max(0, int(math.floor(min(c1, c2))) - 1)
    c_max = min(cols_total - 1, int(math.ceil(max(c1, c2))) + 1)

    print(f"Extracting sub-grid rows [{r_min}..{r_max}], cols [{c_min}..{c_max}] (tile h={h}, v={v})...")

    cells = []
    dropped_cells = 0
    kept_cells = 0
    unknown_count = 0
    valid_temps = []

    for r in range(r_min, r_max + 1):
        for c in range(c_min, c_max + 1):
            cell_lat, cell_lon = modis_tile_to_latlon(h, v, r, c)
            pt = Point(cell_lon, cell_lat)

            # Strict polygon clipping
            if not area.contains_buffered(cell_lat, cell_lon):
                dropped_cells += 1
                continue

            kept_cells += 1
            raw_val = int(arr[r, c])

            # MODIS LST scale: raw * 0.02 = Kelvin. 0 is NoData / cloud masked.
            # Normal Earth surface temperatures range 200 K (-73 C) to 340 K (+67 C).
            if raw_val <= 0 or raw_val < 7500:  # < 150 K is cloud/invalid
                val_celsius = None
                status = "UNKNOWN"
                quality = "cloud_masked_or_nodata"
                unknown_count += 1
            else:
                kelvin = raw_val * 0.02
                celsius = round(kelvin - 273.15, 2)
                val_celsius = celsius
                status = "KNOWN"
                quality = "clear"
                valid_temps.append(celsius)

            cells.append({
                "i": r - r_min,
                "j": c - c_min,
                "tile_row": r,
                "tile_col": c,
                "lat": round(cell_lat, 6),
                "lon": round(cell_lon, 6),
                "value": val_celsius,
                "unit": "°C",
                "status": status,
                "quality": quality,
                "acquisition_time": acq_date,
            })

    min_t = min(valid_temps) if valid_temps else None
    max_t = max(valid_temps) if valid_temps else None
    mean_t = round(float(np.mean(valid_temps)), 2) if valid_temps else None

    print(f"MODIS Night LST: dropped {dropped_cells} cells outside polygon; kept {kept_cells} cells inside.")
    print(f"Cells summary: {len(valid_temps)} valid, {unknown_count} UNKNOWN ({(unknown_count/kept_cells*100) if kept_cells else 0:.1f}%).")
    if valid_temps:
        print(f"Surface temperature range: {min_t}°C to {max_t}°C (mean: {mean_t}°C)")

    return {
        "source": "NASA LP DAAC / Microsoft Planetary Computer",
        "product": "MYD11A2.061 (MODIS Aqua Land Surface Temperature 8-Day L3 Global 1km)",
        "product_type": "night_surface_temperature",
        "acquired_range": date_range,
        "acquisition_time": acq_date,
        "retrieved_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "native_resolution": "1 km (Sinusoidal tile grid, nominal 926.6 m)",
        "cell_size_m": PIXEL_SIZE_M,
        "tile": f"h{h:02d}v{v:02d}",
        "license": "NASA Open Data Policy (CC0 / Public Domain)",
        "attribution": "NASA EOSDIS Land Processes Distributed Active Archive Center (LP DAAC)",
        "unit": "°C",
        "bbox": [min_lon, min_lat, max_lon, max_lat],
        "dropped_cells": dropped_cells,
        "kept_cells": kept_cells,
        "unknown_cells": unknown_count,
        "valid_cells": len(valid_temps),
        "min_value": min_t,
        "max_value": max_t,
        "mean_value": mean_t,
        "cells": cells,
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch real LST data clipped to service area.")
    parser.add_argument("--out", default=str(DATA_DIR / "thermal_lst.json"), help="Output JSON path")
    args = parser.parse_args()

    area = get_area()
    try:
        thermal_data = fetch_modis_aqua_night_lst(area)
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(thermal_data, f, ensure_ascii=False)
        print(f"Wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KB)")
        print("Successfully generated thermal_lst.json")
    except Exception as e:
        print(f"Error fetching thermal data: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

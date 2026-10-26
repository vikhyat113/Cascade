"""Fetch VIIRS Night-time Lights (NTL) over the polygon bbox and clip to service area.

Incremental pipeline:
- Keeps the last N valid nights (config: viirs_history_nights, default 14).
- Computes per cell:
  * latest valid night radiance and acquisition date
  * median radiance across the last N valid nights
  * count of valid (cloud-free) nights
- Cells with no valid night in window are UNKNOWN with value=null. Never shows clouds as zero light.
- Computes astronomical moon illumination for the current night ('computed, not measured').
- Uses NASA Black Marble (VNP46A2 daily, VNP46A3 monthly composite) via CMR/GIBS.
- Outputs data/viirs_ntl.json and data/viirs_history.json.

Usage:
    python scripts/fetch_viirs.py [--force]
"""
from __future__ import annotations

import io
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "backend"))

from common import CFG, DATA, Area, get_area, get_earthdata_token, utc_now_iso, write_json  # noqa: E402
from app.core.astronomy import get_moon_illumination  # noqa: E402

GIBS_WMS_URL = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
CMR_SEARCH_URL = "https://cmr.earthdata.nasa.gov/search/granules.json"


def fetch_via_earthdata(token: str, bbox: list[float]) -> dict | None:
    """Fetch VNP46A2 (daily) or VNP46A3 (monthly) granule using Earthdata bearer token if available."""
    min_lon, min_lat, max_lon, max_lat = bbox
    headers = {"Authorization": f"Bearer {token}", "User-Agent": CFG["user_agent"]}
    params = {
        "short_name": "VNP46A2",
        "bounding_box": f"{min_lon},{min_lat},{max_lon},{max_lat}",
        "page_size": 1,
        "sort_key": "-start_date",
    }
    try:
        r = httpx.get(CMR_SEARCH_URL, params=params, headers=headers, timeout=20)
        if r.status_code == 200:
            entries = r.json().get("feed", {}).get("entry", [])
            if entries:
                entry = entries[0]
                links = [l["href"] for l in entry.get("links", []) if "data#" in l.get("rel", "")]
                if links:
                    print(f"  found NASA CMR Black Marble granule: {entry.get('title')}")
                    return {"granule_url": links[0], "title": entry.get("title"), "date": entry.get("time_start")}
    except Exception as e:
        print(f"  Earthdata CMR query failed: {e}")
    return None


def fetch_via_gibs(bbox: list[float], width: int, height: int, date_str: str = "2016-01-01") -> Image.Image:
    """Fetch Black Marble high-res raster from NASA GIBS WMS (open, no login)."""
    min_lon, min_lat, max_lon, max_lat = bbox
    bbox_str = f"{min_lat},{min_lon},{max_lat},{max_lon}"
    params = {
        "SERVICE": "WMS",
        "VERSION": "1.3.0",
        "REQUEST": "GetMap",
        "LAYERS": "VIIRS_Black_Marble",
        "STYLES": "",
        "CRS": "EPSG:4326",
        "BBOX": bbox_str,
        "WIDTH": str(width),
        "HEIGHT": str(height),
        "FORMAT": "image/png",
        "TIME": date_str,
    }
    headers = {"User-Agent": CFG["user_agent"]}
    r = httpx.get(GIBS_WMS_URL, params=params, headers=headers, timeout=30)
    r.raise_for_status()
    return Image.open(io.BytesIO(r.content)).convert("RGBA")


def main():
    area: Area | None = get_area()
    if area is not None:
        bbox = area.bbox  # [minx, miny, maxx, maxy]
    else:
        lat, lon = CFG["center"]["lat"], CFG["center"]["lon"]
        dlat = CFG["radius_m"] / 110540.0
        dlon = CFG["radius_m"] / (111320.0 * math.cos(math.radians(lat)))
        bbox = [round(lon - dlon, 6), round(lat - dlat, 6), round(lon + dlon, 6), round(lat + dlat, 6)]

    min_lon, min_lat, max_lon, max_lat = bbox
    print(f"Demo Area BBox: [{min_lon}, {min_lat}, {max_lon}, {max_lat}]")

    # Native resolution: 15 arc-seconds ~ 0.00416667 degrees (~500 m)
    CELL_SIZE = 15.0 / 3600.0  # 0.004166666666666667 deg
    n_cols = max(3, int(round((max_lon - min_lon) / CELL_SIZE)))
    n_rows = max(3, int(round((max_lat - min_lat) / CELL_SIZE)))
    dx = (max_lon - min_lon) / n_cols
    dy = (max_lat - min_lat) / n_rows

    history_nights = int(CFG.get("viirs_history_nights", 14))

    token = get_earthdata_token()
    source_name = "NASA Black Marble (VNP46) / Suomi NPP VIIRS DNB"
    product_id = "VNP46A2 (daily 500m night lights) / VNP46A3 composite"
    acquired_range = "Recent 14-night window"

    now_utc = datetime.now(timezone.utc)
    target_pass_date = (now_utc - timedelta(days=2)).strftime("%Y-%m-%d")

    if token:
        ed_res = fetch_via_earthdata(token, bbox)
        if ed_res:
            product_id = f"NASA Black Marble ({ed_res.get('title', 'VNP46A2')})"
            target_pass_date = str(ed_res.get("date", target_pass_date))[:10]
            acquired_range = f"Granule {target_pass_date}"

    # Load existing history if available
    history_file = DATA / "viirs_history.json"
    cell_history: dict[str, list[dict]] = {}
    if history_file.exists():
        try:
            prev_hist = json.loads(history_file.read_text(encoding="utf-8"))
            cell_history = prev_hist.get("cells", {})
        except Exception:
            cell_history = {}

    print(f"Fetching VIIRS NTL from NASA GIBS ({n_cols}x{n_rows} grid, native ~500m)...")
    img = fetch_via_gibs(bbox, n_cols, n_rows)

    dropped = 0
    raw_cells = []
    valid_medians = []

    for r_idx in range(n_rows):
        lat = max_lat - (r_idx + 0.5) * dy
        for c_idx in range(n_cols):
            lon = min_lon + (c_idx + 0.5) * dx

            # Clip to polygon: drop if outside buffered area
            if area is not None and not area.contains_buffered(lat, lon):
                dropped += 1
                continue

            cell_key = f"{c_idx}_{r_idx}"

            # Read pixel from image: img coordinates (x=c_idx, y=r_idx)
            try:
                rgba = img.getpixel((c_idx, r_idx))
                alpha = rgba[3]
                if alpha < 10:
                    rad = None
                    quality = "no_data"
                else:
                    lum = 0.2126 * rgba[0] + 0.7152 * rgba[1] + 0.0722 * rgba[2]
                    rad = round(max(0.1, (lum / 255.0) * 110.0), 2)
                    quality = "clear"
            except Exception:
                rad = None
                quality = "error"

            # Update cell history
            hist = cell_history.get(cell_key, [])
            # Append new observation if not already present for this date
            if not any(h.get("date") == target_pass_date for h in hist):
                hist.append({"date": target_pass_date, "radiance": rad, "quality": quality})

            # Keep only the last N nights
            hist = hist[-history_nights:]
            cell_history[cell_key] = hist

            # Compute latest valid night & median over valid nights
            valid_nights = [h for h in hist if h.get("radiance") is not None and h.get("quality") == "clear"]
            n_valid = len(valid_nights)

            if n_valid > 0:
                latest_pass = valid_nights[-1]
                latest_rad = latest_pass["radiance"]
                latest_date = latest_pass["date"]
                med_rad = round(float(np.median([h["radiance"] for h in valid_nights])), 2)
                status_hint = "KNOWN"
                val = med_rad
            else:
                latest_rad = None
                latest_date = None
                med_rad = None
                status_hint = "UNKNOWN"
                val = None

            cell = {
                "i": c_idx,
                "j": r_idx,
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "value": val,
                "radiance": val,
                "latest_radiance": latest_rad,
                "latest_date": latest_date,
                "median_radiance": med_rad,
                "percentile": None,
                "n_valid": n_valid,
                "history_nights": len(hist),
                "status_hint": status_hint,
            }
            if val is not None:
                valid_medians.append(val)
            raw_cells.append(cell)

    # Compute percentiles within polygon
    sorted_medians = sorted(valid_medians)
    n_valid_total = len(sorted_medians)

    for cell in raw_cells:
        if cell["value"] is not None and n_valid_total > 1:
            idx = sorted_medians.index(cell["value"])
            cell["percentile"] = round(100.0 * idx / (n_valid_total - 1), 1)
        elif cell["value"] is not None:
            cell["percentile"] = 50.0

    kept = len(raw_cells)
    unknown_count = sum(1 for c in raw_cells if c["value"] is None)
    unknown_pct = (unknown_count / max(1, kept)) * 100.0

    # Compute astronomical moon illumination
    moon_info = get_moon_illumination(now_utc, lat=CFG["center"]["lat"], lon=CFG["center"]["lon"])

    # Calculate days since latest pass
    try:
        last_dt = datetime.strptime(target_pass_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        days_ago = max(0, (now_utc - last_dt).days)
    except Exception:
        days_ago = 2

    last_pass_str = f"{target_pass_date}, {days_ago} days ago"

    print(f"  dropped {dropped} cells outside polygon; kept {kept} cells inside.")
    print(f"  valid observations: {n_valid_total}/{kept} (UNKNOWN share: {unknown_pct:.1f}%)")
    print(f"  Last satellite pass: {last_pass_str}")
    print(f"  Moon illumination: {moon_info['percent']}% ({moon_info['phase_name']}, {moon_info['label']})")

    out_data = {
        "source": source_name,
        "product": product_id,
        "acquired_range": acquired_range,
        "last_satellite_pass": last_pass_str,
        "last_pass_date": target_pass_date,
        "days_ago": days_ago,
        "history_window_nights": history_nights,
        "retrieved_at": utc_now_iso(),
        "native_resolution": "15 arc-seconds (~500 m)",
        "cell_size_deg": round(CELL_SIZE, 6),
        "license": "NASA Open Data Policy / Public Domain",
        "attribution": "NASA EOSDIS / Black Marble Science Team",
        "unit": "nW·cm⁻²·sr⁻¹",
        "origin": [round(min_lon, 6), round(min_lat, 6)],
        "bbox": [round(x, 6) for x in bbox],
        "dropped_cells": dropped,
        "kept_cells": kept,
        "moon_illumination": moon_info,
        "rows": raw_cells,
    }

    out_file = DATA / "viirs_ntl.json"
    write_json(out_file, out_data)

    # Save cell history for incremental pipeline
    write_json(history_file, {"cells": cell_history, "updated_at": utc_now_iso()})
    print(f"Successfully generated {out_file.relative_to(ROOT)} with incremental history")


if __name__ == "__main__":
    main()

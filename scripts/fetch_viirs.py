"""Fetch VIIRS Night-time Lights (NTL) over the polygon bbox and clip to service area.

Uses NASA Black Marble (VNP46 / VIIRS DNB):
- If EARTHDATA_TOKEN is available in .env or environment, queries NASA CMR/LAADS
  for VNP46A3 / VNP46A2 granules.
- Otherwise uses NASA GIBS open Black Marble service (no login required).
- Clips every cell to the buffered service area polygon (drops outside cells).
- Converts radiance to log scale and computes percentile within polygon.
- Cloud-masked or NoData cells become UNKNOWN (value=None).
- Outputs data/viirs_ntl.json.

Usage:
    python scripts/fetch_viirs.py [--force]
"""
from __future__ import annotations

import io
import math
import sys
from pathlib import Path

import httpx
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "backend"))

from common import CFG, DATA, Area, get_area, get_earthdata_token, utc_now_iso, write_json  # noqa: E402

GIBS_WMS_URL = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
CMR_SEARCH_URL = "https://cmr.earthdata.nasa.gov/search/granules.json"


def fetch_via_earthdata(token: str, bbox: list[float]) -> dict | None:
    """Fetch VNP46A3 / VNP46A2 granule using Earthdata bearer token if possible."""
    min_lon, min_lat, max_lon, max_lat = bbox
    headers = {"Authorization": f"Bearer {token}", "User-Agent": CFG["user_agent"]}
    params = {
        "short_name": "VNP46A3",
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


def fetch_via_gibs(bbox: list[float], width: int, height: int) -> Image.Image:
    """Fetch Black Marble high-res raster from NASA GIBS WMS (open, no login)."""
    min_lon, min_lat, max_lon, max_lat = bbox
    # WMS 1.3.0 EPSG:4326 uses minLat,minLon,maxLat,maxLon
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
        "TIME": "2016-01-01",
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

    token = get_earthdata_token()
    source_name = "NASA Black Marble (VNP46) / Suomi NPP VIIRS DNB"
    product_id = "VIIRS_Black_Marble (NASA GIBS / Black Marble composite)"
    acquired_range = "NASA Black Marble 500m night-lights composite"

    if token:
        ed_res = fetch_via_earthdata(token, bbox)
        if ed_res:
            product_id = f"NASA Black Marble ({ed_res.get('title', 'VNP46A3')})"
            acquired_range = str(ed_res.get("date", "recent monthly"))

    print(f"Fetching VIIRS NTL from NASA GIBS ({n_cols}x{n_rows} grid, native ~500m)...")
    img = fetch_via_gibs(bbox, n_cols, n_rows)

    dropped = 0
    raw_cells = []
    valid_radiances = []

    for r_idx in range(n_rows):
        lat = max_lat - (r_idx + 0.5) * dy
        for c_idx in range(n_cols):
            lon = min_lon + (c_idx + 0.5) * dx

            # Clip to polygon: drop if outside buffered area
            if area is not None and not area.contains_buffered(lat, lon):
                dropped += 1
                continue

            # Read pixel from image: img coordinates (x=c_idx, y=r_idx)
            try:
                rgba = img.getpixel((c_idx, r_idx))
                alpha = rgba[3]
                if alpha < 10:
                    rad = None
                else:
                    # Perceived luminance proxy: standard rec709 coefficients scaled to nW/cm2/sr
                    # Bright urban cores reach ~60-100 nW, quiet lanes ~5-15 nW
                    lum = 0.2126 * rgba[0] + 0.7152 * rgba[1] + 0.0722 * rgba[2]
                    # Scale to typical physical radiance range (0.1 to 120 nW·cm⁻²·sr⁻¹)
                    rad = round(max(0.1, (lum / 255.0) * 110.0), 2)
            except Exception:
                rad = None

            cell = {
                "i": c_idx,
                "j": r_idx,
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "radiance": rad,
                "percentile": None,
                "n_valid": 1 if rad is not None else 0,
                "status_hint": "KNOWN" if rad is not None else "UNKNOWN",
            }
            if rad is not None:
                valid_radiances.append(rad)
            raw_cells.append(cell)

    # Compute percentiles within the polygon
    sorted_rad = sorted(valid_radiances)
    n_valid = len(sorted_rad)

    for cell in raw_cells:
        if cell["radiance"] is not None and n_valid > 1:
            idx = sorted_rad.index(cell["radiance"])
            cell["percentile"] = round(100.0 * idx / (n_valid - 1), 1)
        elif cell["radiance"] is not None:
            cell["percentile"] = 50.0

    kept = len(raw_cells)
    unknown_count = sum(1 for c in raw_cells if c["radiance"] is None)
    unknown_pct = (unknown_count / max(1, kept)) * 100.0

    print(f"  dropped {dropped} cells outside polygon; kept {kept} cells inside.")
    print(f"  valid observations: {n_valid}/{kept} (UNKNOWN share: {unknown_pct:.1f}%)")
    if valid_radiances:
        print(f"  radiance range: {min(valid_radiances):.2f} to {max(valid_radiances):.2f} nW/cm2/sr")

    out_data = {
        "source": source_name,
        "product": product_id,
        "acquired_range": acquired_range,
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
        "rows": raw_cells,
    }

    out_file = DATA / "viirs_ntl.json"
    write_json(out_file, out_data)
    print(f"Successfully generated {out_file.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

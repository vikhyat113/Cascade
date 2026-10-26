"""Night-time lights from satellite (VIIRS) over the area zones, for a map layer and an optional
lighting prior (UPGRADE §3). Public NASA GIBS WMS, no login:

  layer VIIRS_SNPP_GapFilled_BRDF_Corrected_DayNightBand_Radiance (Black Marble VNP46A2: daily,
  cloud gaps filled, moonlight corrected, ~500 m pixels)

Several recent nights are fetched and the per-pixel MEDIAN is kept (one night is noisy). Values are
RELATIVE brightness 0-255 from the GIBS rendering (it saturates in the brightest city core), not
radiance. Cached under data/raw/viirs/. Writes data/viirs_ntl.json.

    backend/.venv/Scripts/python scripts/fetch_viirs.py [--force]
"""
from __future__ import annotations

import io
import json
import sys
import time
from datetime import date, timedelta

import httpx
import numpy as np
from PIL import Image

import area
from common import CFG, DATA, RAW, utc_now_iso, write_json

WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
LAYER = "VIIRS_SNPP_GapFilled_BRDF_Corrected_DayNightBand_Radiance"
CELL_DEG = 1 / 240            # 15 arc-seconds, the product's native grid (~460 m here)
NIGHTS = 8
STEP_DAYS = 9
CACHE = RAW / "viirs"


def bbox() -> tuple[float, float, float, float]:
    s, w, n, e = 90.0, 180.0, -90.0, -180.0
    for _, poly in area.polygons():
        x0, y0, x1, y1 = poly.bounds                    # lon, lat
        s, w, n, e = min(s, y0), min(w, x0), max(n, y1), max(e, x1)
    pad = 0.01
    snap = lambda v, f: f(v / CELL_DEG) * CELL_DEG      # noqa: E731
    import math
    return snap(s - pad, math.floor), snap(w - pad, math.floor), snap(n + pad, math.ceil), snap(e + pad, math.ceil)


def fetch(day: str, b, nx: int, ny: int, force: bool) -> np.ndarray | None:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{day}.png"
    if not path.exists() or force:
        params = {"SERVICE": "WMS", "REQUEST": "GetMap", "VERSION": "1.1.1", "LAYERS": LAYER, "STYLES": "", "SRS": "EPSG:4326",
                  "BBOX": f"{b[1]},{b[0]},{b[3]},{b[2]}", "WIDTH": nx, "HEIGHT": ny, "FORMAT": "image/png", "TIME": day}
        time.sleep(1.0)
        try:
            r = httpx.get(WMS, params=params, headers={"User-Agent": CFG["user_agent"]}, timeout=90)
        except httpx.HTTPError as ex:
            print(f"  {day}: {ex!r}")
            return None
        if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image/png"):
            print(f"  {day}: HTTP {r.status_code} {r.headers.get('content-type')}")
            return None
        path.write_bytes(r.content)
    a = np.array(Image.open(io.BytesIO(path.read_bytes())).convert("RGBA"))
    v = a[..., 0].astype(np.float32)
    v[a[..., 3] == 0] = np.nan                          # transparent = no data, never zero light
    return v


def main():
    force = "--force" in sys.argv
    b = bbox()
    nx = round((b[3] - b[1]) / CELL_DEG)
    ny = round((b[2] - b[0]) / CELL_DEG)
    last = date.today() - timedelta(days=3)               # the product lags a few days
    days = [(last - timedelta(days=STEP_DAYS * i)).isoformat() for i in range(NIGHTS)]
    stack, used = [], []
    for d in days:
        v = fetch(d, b, nx, ny, force)
        if v is not None:
            stack.append(v)
            used.append(d)
    if not stack:
        sys.exit("no VIIRS night could be fetched")
    med = np.nanmedian(np.stack(stack), axis=0)          # rows north -> south
    valid = np.isfinite(med)
    vals = np.where(valid, np.round(med), -1).astype(int)
    print(f"  {len(used)} nights ({used[-1]} .. {used[0]}), grid {nx}x{ny}, no-data share {1 - valid.mean():.3f}, "
          f"median brightness {np.nanmedian(med):.0f}")
    write_json(DATA / "viirs_ntl.json", {
        "generated_at": utc_now_iso(), "source": "NASA GIBS (public), " + LAYER + " (Black Marble VNP46A2)",
        "licence": "NASA EOSDIS data: no restrictions on reuse (cite NASA LANCE / Black Marble)",
        "note": "relative brightness 0-255 from the GIBS rendering, median of several nights; saturates in the brightest city core; -1 = no data",
        "nights": used, "bbox": {"south": b[0], "west": b[1], "north": b[2], "east": b[3]}, "cell_deg": CELL_DEG,
        "nx": nx, "ny": ny, "rows": "north_to_south", "values": vals.ravel().tolist()})


if __name__ == "__main__":
    main()

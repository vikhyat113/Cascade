"""Shared helpers for the one-off data download / build scripts.

Everything here runs *before* the demo. Results are cached under data/ and the
backend only ever reads those files, so no public API is hit during the demo.
"""
from __future__ import annotations

import gzip
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
CONFIG_PATH = BACKEND / "config.yaml"


def load_config() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return yaml.safe_load(f)


CFG = load_config()
DATA = (BACKEND / CFG["data_dir"]).resolve()
RAW = DATA / "raw"
DATA.mkdir(parents=True, exist_ok=True)
RAW.mkdir(parents=True, exist_ok=True)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def write_json(path: Path, obj, compress: bool = False) -> None:
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    if compress:
        with gzip.open(path, "wt", encoding="utf-8") as f:
            f.write(text)
    else:
        path.write_text(text, encoding="utf-8")
    print(f"  wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1024:.0f} KB)")


def read_json(path: Path):
    if str(path).endswith(".gz"):
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    return json.loads(path.read_text(encoding="utf-8"))


_last_request = 0.0


def overpass(query: str, cache_name: str, force: bool = False) -> dict:
    """POST an Overpass query with fair-use behaviour: identifying UA, >=1 s
    between requests, exponential backoff, mirror fallback, disk cache."""
    import httpx

    global _last_request
    cache = RAW / cache_name
    if cache.exists() and not force:
        print(f"  using cached {cache.relative_to(ROOT)}")
        return json.loads(cache.read_text(encoding="utf-8"))

    headers = {"User-Agent": CFG["user_agent"]}
    last_err = None
    for attempt in range(6):
        url = CFG["overpass_urls"][attempt % len(CFG["overpass_urls"])]
        wait = max(0.0, 1.0 - (time.time() - _last_request))
        time.sleep(wait)
        try:
            print(f"  overpass -> {url} (attempt {attempt + 1})")
            _last_request = time.time()
            r = httpx.post(url, data={"data": query}, headers=headers, timeout=180)
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                data = r.json()
                cache.write_text(json.dumps(data), encoding="utf-8")
                return data
            last_err = f"HTTP {r.status_code}: {r.text[:120]}"
        except Exception as e:  # network errors, timeouts
            last_err = repr(e)
        backoff = min(60, 2 ** attempt * 2)
        print(f"    failed ({last_err}); backing off {backoff}s")
        time.sleep(backoff)
    sys.exit(f"Overpass failed after retries: {last_err}")


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))

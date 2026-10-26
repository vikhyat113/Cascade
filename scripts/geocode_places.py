"""Geocode the demo places once with Nominatim (OpenStreetMap) and cache the answers.

    backend/.venv/Scripts/python scripts/geocode_places.py [--force]

Fair use (Nominatim usage policy): one request per place, >= 1.1 s apart, an identifying
User-Agent, results cached in data/raw/nominatim.json and never requested again.
"""
from __future__ import annotations

import json
import sys
import time

import httpx

from common import CFG, RAW

URL = "https://nominatim.openstreetmap.org/search"
QUERIES = [
    "Butibori, Nagpur",
    "Indian Institute of Information Technology Nagpur",
    "Butibori MIDC",
    "Sitabuldi, Nagpur",
    "Nagpur Railway Station",
    "Dharampeth, Nagpur",
    "Sadar, Nagpur",
    "Zero Mile, Nagpur",
]
CACHE = RAW / "nominatim.json"


def main():
    force = "--force" in sys.argv
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    for q in QUERIES:
        if q in cache and not force:
            continue
        time.sleep(1.1)
        r = httpx.get(URL, params={"q": q, "format": "jsonv2", "limit": 3, "countrycodes": "in"},
                      headers={"User-Agent": CFG["user_agent"]}, timeout=30)
        r.raise_for_status()
        cache[q] = [{"name": x.get("display_name"), "lat": float(x["lat"]), "lon": float(x["lon"]),
                     "type": f'{x.get("category")}/{x.get("type")}'} for x in r.json()]
        CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    for q in QUERIES:
        hits = cache.get(q) or []
        top = hits[0] if hits else None
        print(f"{q:<52} -> " + (f"{top['lat']:.5f}, {top['lon']:.5f}  {top['type']}  {top['name'][:70]}" if top else "NOT FOUND"))


if __name__ == "__main__":
    main()

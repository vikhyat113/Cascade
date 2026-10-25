"""Fetch facilities, transit stops, street lamps and named places from Overpass
(one cached query) and write data/pois.json.

    python scripts/fetch_pois.py [--force]

We keep the element's last-edit timestamp (from `out meta`) so opening hours can
be aged by the freshness engine, and drop editor names/ids (not needed).
"""
from __future__ import annotations

import sys

from common import CFG, DATA, get_area, overpass, utc_now_iso, write_json

area = get_area()
if area is not None:
    A = f"({area.overpass_poly_str})"
else:
    LAT, LON, R = CFG["center"]["lat"], CFG["center"]["lon"], CFG["radius_m"]
    A = f"(around:{R},{LAT},{LON})"


QUERY = f"""
[out:json][timeout:170];
(
  nwr["amenity"~"^(hospital|clinic|doctors|pharmacy|police|fire_station|fuel|atm|bank|cafe|fast_food|restaurant|food_court|bus_station|toilets)$"]{A};
  nwr["healthcare"~"^(hospital|clinic|pharmacy)$"]{A};
  nwr["shop"~"^(convenience|supermarket|chemist|bakery|kiosk)$"]{A};
  node["highway"="bus_stop"]{A};
  nwr["public_transport"="station"]{A};
  nwr["railway"~"^(station|subway_entrance)$"]{A};
  node["highway"="street_lamp"]{A};
  node["place"~"^(suburb|neighbourhood|quarter|locality|village|hamlet)$"]{A};
  way["place"~"^(suburb|neighbourhood|quarter|locality)$"]{A};
  way["landuse"="industrial"]{A};
);
out center meta;
"""


def category(t: dict) -> str | None:
    a, s, hc = t.get("amenity"), t.get("shop"), t.get("healthcare")
    if t.get("highway") == "street_lamp":
        return "street_lamp"
    if t.get("highway") == "bus_stop" or a == "bus_station":
        return "bus_stop"
    if t.get("railway") in ("station", "subway_entrance") or t.get("public_transport") == "station":
        if t.get("station") == "subway" or t.get("subway") == "yes" or "metro" in (t.get("name") or "").lower() \
                or t.get("railway") == "subway_entrance" or t.get("network", "").lower().startswith("delhi metro"):
            return "metro_station"
        return "rail_station"
    if t.get("place"):
        return "place"
    if t.get("landuse") == "industrial":
        return "industrial"
    if a == "hospital" or hc == "hospital":
        return "hospital"
    if a in ("clinic", "doctors") or hc == "clinic":
        return "clinic"
    if a == "pharmacy" or s == "chemist" or hc == "pharmacy":
        return "pharmacy"
    if a in ("police", "fire_station", "fuel", "atm", "bank", "toilets"):
        return a
    if a in ("cafe", "fast_food", "restaurant", "food_court") or s == "bakery":
        return "food"
    if s in ("convenience", "supermarket", "kiosk"):
        return "shop"
    return None


KEEP_TAGS = ("name", "opening_hours", "emergency", "amenity", "shop", "healthcare", "brand",
             "operator", "addr:street", "route_ref", "network", "station", "lit", "place")


def main():
    force = "--force" in sys.argv
    data = overpass(QUERY, "overpass_pois.json", force=force)
    out, seen = [], set()
    for e in data.get("elements", []):
        t = e.get("tags", {})
        cat = category(t)
        if not cat:
            continue
        lat = e.get("lat") or e.get("center", {}).get("lat")
        lon = e.get("lon") or e.get("center", {}).get("lon")
        if lat is None or lon is None:
            continue
        pid = f"{e['type'][0]}{e['id']}"
        if pid in seen:
            continue
        seen.add(pid)
        rec = {"id": pid, "cat": cat, "lat": round(lat, 6), "lon": round(lon, 6),
               "name": t.get("name") or t.get("name:en"),
               "edited_at": e.get("timestamp"),
               "tags": {k: v for k, v in t.items() if k in KEEP_TAGS}}
        out.append(rec)
    counts = {}
    for r in out:
        counts[r["cat"]] = counts.get(r["cat"], 0) + 1
    print("  categories:", dict(sorted(counts.items())))
    hours = sum(1 for r in out if r["tags"].get("opening_hours"))
    print(f"  {hours} elements carry opening_hours")
    write_json(DATA / "pois.json", {"generated_at": utc_now_iso(),
                                     "source": "OpenStreetMap contributors via Overpass API",
                                     "center": CFG["center"], "radius_m": CFG["radius_m"], "pois": out})


if __name__ == "__main__":
    main()

"""Fetch facilities, transit stops, street lamps and named places from Overpass
(one cached query) and write data/pois.json.

    python scripts/fetch_pois.py [--force]

We keep the element's last-edit timestamp (from `out meta`) so opening hours can
be aged by the freshness engine, and drop editor names/ids (not needed).
"""
from __future__ import annotations

import sys

import area
from common import CFG, DATA, overpass, utc_now_iso, write_json

R = CFG["radius_m"]


def zone_query() -> str:
    """One Overpass query over every zone polygon (UPGRADE §2: the area is zones, not a circle)."""
    parts = []
    for _, poly in area.polygons():
        A = f"({area.overpass_poly(poly)})"
        parts.append(f"""
  nwr["amenity"~"^(hospital|clinic|doctors|pharmacy|police|fire_station|fuel|atm|bank|cafe|fast_food|restaurant|bus_station|toilets|hotel)$"]{A};
  nwr["tourism"~"^(hotel|guest_house)$"]{A};
  nwr["healthcare"~"^(hospital|clinic|pharmacy)$"]{A};
  nwr["shop"~"^(convenience|supermarket|chemist|bakery|kiosk)$"]{A};
  node["highway"="bus_stop"]{A};
  nwr["public_transport"~"^(station|platform|stop_position)$"]{A};
  nwr["railway"~"^(station|subway_entrance|halt)$"]{A};
  node["highway"="street_lamp"]{A};
  node["place"~"^(suburb|neighbourhood|quarter|locality|village|hamlet|town)$"]{A};
  way["place"~"^(suburb|neighbourhood|quarter|locality)$"]{A};
  way["landuse"="industrial"]{A};""")
    return "[out:json][timeout:170];\n(" + "".join(parts) + "\n);\nout center meta;\n"


def category(t: dict) -> str | None:
    a, s, hc = t.get("amenity"), t.get("shop"), t.get("healthcare")
    if t.get("highway") == "street_lamp":
        return "street_lamp"
    if t.get("highway") == "bus_stop" or a == "bus_station" or             (t.get("public_transport") in ("platform", "stop_position") and (t.get("bus") == "yes" or t.get("highway") == "bus_stop")):
        return "bus_stop"
    if t.get("railway") in ("station", "subway_entrance") or t.get("public_transport") == "station":
        if t.get("station") == "subway" or t.get("subway") == "yes" or "metro" in (t.get("name") or "").lower() \
                or t.get("railway") == "subway_entrance" or "metro" in t.get("network", "").lower():
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
    if a == "hotel" or t.get("tourism") in ("hotel", "guest_house"):
        return "hotel"
    if a in ("cafe", "fast_food", "restaurant") or s == "bakery":
        return "food"
    if s in ("convenience", "supermarket", "kiosk"):
        return "shop"
    return None


KEEP_TAGS = ("name", "opening_hours", "emergency", "amenity", "shop", "healthcare", "brand",
             "operator", "addr:street", "route_ref", "network", "station", "lit", "place", "phone", "contact:phone",
             "tourism", "public_transport", "bus", "railway")


def main():
    force = "--force" in sys.argv
    data = overpass(zone_query(), "overpass_pois.json", force=force)
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
                                     "center": CFG["center"], "radius_m": R, "pois": out})


if __name__ == "__main__":
    main()

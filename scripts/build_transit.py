"""Build data/transit_schedule.json from the best transit source that exists (UPGRADE §5.2):

  1. OpenStreetMap route relations (bus / minibus / subway / light rail) in the area: real stops in
     order, `interval` and `opening_hours` when tagged.
  2. A published GTFS feed: none found for Nagpur (see docs/TRANSIT_DATA.md), so none is read here.
  3. data/manual_bus_routes.csv: real routes typed in by the team (stop names snapped to OSM).
  4. Coverage test for buses: >= 5 real routes with >= 6 stops that connect the demo places.
  If buses fail it, the ESTIMATED fallback below is used: plausible routes through real OSM stops (plus
  stops placed every few hundred metres, marked estimated), assumed headways, service hours UNKNOWN.
  Never invents night service: routes without real hours get "hours_known": false.

    backend/.venv/Scripts/python scripts/build_transit.py
"""
from __future__ import annotations

import csv
import math
import re
import sys
from pathlib import Path

import numpy as np

from common import BACKEND, CFG, DATA, RAW, overpass, read_json, utc_now_iso, write_json

sys.path.insert(0, str(BACKEND))
from app.adapters.geo import LocalProjection  # noqa: E402
from app.adapters.osm import RoadGraph, load_pack  # noqa: E402

BUS_SPEED_MPS = 6.5        # ~23 km/h average incl. stops
METRO_SPEED_MPS = 9.7      # ~35 km/h average
DWELL_S = 20
MANUAL_CSV = DATA / "manual_bus_routes.csv"
MANUAL_COLUMNS = ["route_ref", "route_name", "direction", "stop_order", "stop_name", "lat", "lon", "first_bus", "last_bus", "headway_min"]
METRO_COLORS = {"orange": "#f97316", "aqua": "#22d3ee"}
BUS_COLORS = ["#f59e0b", "#a78bfa", "#34d399", "#fb7185", "#facc15", "#60a5fa"]

# ESTIMATED fallback routes (only when no real bus source passes the coverage test). Waypoints are real
# places; ids start with "E" so they are never mistaken for real route numbers. Hours: unknown.
ESTIMATED = [
    {"id": "E1", "name": "Butibori - Wardha Road - Sitabuldi", "headway_min": 30, "stop_every_m": 1500,
     "via": [("Butibori", 20.91849, 79.01328), ("Khapri Depot", 21.05591, 79.05339), ("Ajni Square", 21.11821, 79.07211),
             ("Sitabuldi City Bus Stand", 21.14251, 79.07958)]},
    {"id": "E2", "name": "IIIT Nagpur (Waranga) - Butibori", "headway_min": 30, "stop_every_m": 900,
     "via": [("IIIT Nagpur (Waranga)", 20.94605, 79.04305), ("Butibori", 20.91849, 79.01328)]},
    {"id": "E3", "name": "Railway Station - Sitabuldi - Dharampeth", "headway_min": 20, "stop_every_m": 600,
     "via": [("Railway Station", 21.1537, 79.08626), ("Sitabuldi City Bus Stand", 21.14251, 79.07958), ("Khurana", 21.14633, 79.06991),
             ("Dharampeth", 21.14097, 79.06243), ("Abhayankar nagar bus stop", 21.12562, 79.05863)]},
    {"id": "E4", "name": "Sadar - Sitabuldi - Ajni", "headway_min": 20, "stop_every_m": 600,
     "via": [("Sadar", 21.1592, 79.07961), ("Sitabardi bus terminal", 21.14401, 79.07805), ("Ajni Square", 21.11821, 79.07211)]},
]
ESTIMATED_HEADWAY_NOTE = "assumed headway; service hours not known"


def dist_m(a, b) -> float:
    kx = 111320 * math.cos(math.radians(a[0]))
    return math.hypot((a[0] - b[0]) * 110540, (a[1] - b[1]) * kx)


def parse_hours(oh: str | None):
    """`06:00-22:00` (one daily range) -> ("06:00", "22:00"); anything else -> None (hours unknown)."""
    m = re.fullmatch(r"\s*(?:Mo-Su\s+)?(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*", oh or "")
    return (m.group(1).zfill(5), m.group(2).zfill(5)) if m else None


def parse_interval(v: str | None):
    """OSM `interval` (`00:15:00`, `15`, `00:15`) -> minutes."""
    if not v:
        return None
    parts = [int(p) for p in re.findall(r"\d+", v)]
    if len(parts) == 1:
        return parts[0]
    if len(parts) >= 2:
        return parts[0] * 60 + parts[1] if len(parts) == 3 or parts[0] < 3 else parts[0]
    return None


# ---- 1. OSM route relations ------------------------------------------------------------------------
def osm_routes(proj) -> tuple[list[dict], dict]:
    s, n = min(z["lat"] - 0.06 for z in CFG["area"]["zones"]), max(z["lat"] + 0.06 for z in CFG["area"]["zones"])
    w, e = min(z["lon"] - 0.06 for z in CFG["area"]["zones"]), max(z["lon"] + 0.06 for z in CFG["area"]["zones"])
    q = f"""[out:json][timeout:170];
relation["route"~"^(bus|minibus|subway|light_rail|tram|monorail)$"]({s},{w},{n},{e})->.r;
.r out body;
node(r.r);
out body;"""
    d = overpass(q, "overpass_transit_routes.json")
    nodes = {x["id"]: x for x in d["elements"] if x["type"] == "node"}
    rels = [x for x in d["elements"] if x["type"] == "relation"]
    report = {"relations": len(rels), "by_mode": {}}
    groups: dict[tuple, list[dict]] = {}
    for r in rels:
        t = r["tags"]
        mode = "metro" if t["route"] in ("subway", "light_rail", "monorail") else "bus"
        report["by_mode"][t["route"]] = report["by_mode"].get(t["route"], 0) + 1
        groups.setdefault((mode, t.get("ref") or t.get("name")), []).append(r)
    out = []
    for (mode, ref), rs in groups.items():
        best = None
        for r in rs:                                  # the longest direction; both directions run
            stops = []
            for m in r["members"]:
                if m["type"] != "node" or not m["role"].startswith("stop"):
                    continue
                nd = nodes.get(m["ref"])
                if not nd:
                    continue
                tg = nd.get("tags", {})
                name = tg.get("name:en") or tg.get("name") or "Stop"
                if stops and stops[-1]["name"] == name:
                    continue
                stops.append({"id": f"n{nd['id']}", "name": name, "lat": round(nd["lat"], 6), "lon": round(nd["lon"], 6)})
            if len(stops) >= 2 and (best is None or len(stops) > len(best[1])):
                best = (r, stops)
        if not best:
            continue
        r, stops = best
        t = r["tags"]
        hours, interval = parse_hours(t.get("opening_hours")), parse_interval(t.get("interval"))
        speed = METRO_SPEED_MPS if mode == "metro" else BUS_SPEED_MPS
        dwell = 30 if mode == "metro" else DWELL_S
        seg_s = [round(dist_m((a["lat"], a["lon"]), (b["lat"], b["lon"])) * 1.15 / speed + dwell) for a, b in zip(stops, stops[1:])]
        rid = re.sub(r"[^A-Z0-9]", "", str(ref).upper().replace("LINE", "")) or f"R{len(out) + 1}"
        known = bool(hours and interval)
        out.append({
            "id": rid, "name": t.get("name:en") or str(ref), "mode": mode, "operator": t.get("operator") or t.get("network"),
            "color": t.get("colour") or METRO_COLORS.get(str(ref).split()[0].lower(), "#60a5fa"),
            "stops": stops, "seg_s": seg_s, "dwell_s": dwell, "both_directions": True,
            "service": [{"from": hours[0], "to": hours[1], "headway_min": interval}] if known else [],
            "hours_known": known, "headway_min": interval, "source": "osm", "synthetic": False,
            "note": f"OpenStreetMap relation {r['id']}: interval {t.get('interval')}, hours {t.get('opening_hours')}" if known
                    else "OpenStreetMap relation without service hours: hours not known",
            "shape": [[s_["lon"], s_["lat"]] for s_ in stops]})
        print(f"  OSM {mode} {rid}: {len(stops)} stops, {'hours ' + hours[0] + '-' + hours[1] + f' every {interval} min' if known else 'hours unknown'}")
    return out, report


# ---- 3. manual routes typed in by the team -----------------------------------------------------------------
def manual_routes(pois) -> list[dict]:
    if not MANUAL_CSV.exists():
        with open(MANUAL_CSV, "w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(MANUAL_COLUMNS)
        print(f"  created the template {MANUAL_CSV.name} (fill it with real routes, then re-run)")
        return []
    rows = list(csv.DictReader(open(MANUAL_CSV, encoding="utf-8")))
    if not rows:
        return []
    stops_by_name = {}
    for p in pois:
        if p["cat"] in ("bus_stop", "metro_station", "rail_station") and p.get("name"):
            stops_by_name.setdefault(p["name"].lower(), p)
    routes: dict[tuple, list[dict]] = {}
    unmatched = []
    for r in rows:
        routes.setdefault((r["route_ref"], r.get("direction") or "A"), []).append(r)
    out = []
    for (ref, direction), rs in routes.items():
        if direction not in ("A", "1", "up", "") and (ref, "A") in routes:
            continue                                     # one direction is enough: both run
        rs.sort(key=lambda x: int(x["stop_order"] or 0))
        stops = []
        for r in rs:
            if r.get("lat") and r.get("lon"):
                lat, lon = float(r["lat"]), float(r["lon"])
            else:
                p = stops_by_name.get(r["stop_name"].strip().lower())
                if not p:
                    unmatched.append(f"{ref}: {r['stop_name']}")
                    continue
                lat, lon = p["lat"], p["lon"]
            stops.append({"id": f"m{ref}-{len(stops)}", "name": r["stop_name"].strip(), "lat": lat, "lon": lon})
        if len(stops) < 2:
            continue
        first, last, hw = rs[0].get("first_bus"), rs[0].get("last_bus"), rs[0].get("headway_min")
        known = bool(first and last and hw)
        seg_s = [round(dist_m((a["lat"], a["lon"]), (b["lat"], b["lon"])) * 1.3 / BUS_SPEED_MPS + DWELL_S) for a, b in zip(stops, stops[1:])]
        out.append({"id": ref, "name": rs[0].get("route_name") or ref, "mode": "bus", "color": BUS_COLORS[len(out) % len(BUS_COLORS)],
                    "stops": stops, "seg_s": seg_s, "dwell_s": DWELL_S, "both_directions": True,
                    "service": [{"from": first, "to": last, "headway_min": int(hw)}] if known else [],
                    "hours_known": known, "headway_min": int(hw) if hw else None, "source": "manual", "synthetic": False,
                    "note": "typed in by the team (data/manual_bus_routes.csv)",
                    "shape": [[s_["lon"], s_["lat"]] for s_ in stops]})
    for u in unmatched:
        print(f"  manual CSV: stop not found in OSM, add lat/lon: {u}")
    return out


def coverage_ok(routes: list[dict]) -> tuple[bool, str]:
    real = [r for r in routes if r["mode"] == "bus" and not r["synthetic"] and len(r["stops"]) >= 6]
    return len(real) >= 5, f"{len(real)} real bus routes with >= 6 stops (need 5)"


# ---- ESTIMATED fallback ------------------------------------------------------------------------------------
def estimated_routes(G: RoadGraph, proj, pois) -> list[dict]:
    osm_stops = [p for p in pois if p["cat"] == "bus_stop"]
    places = [p for p in pois if p.get("name") and p["cat"] in ("place", "metro_station", "rail_station")]

    def stop_name(lat, lon, used: dict) -> str:
        """Locality (OSM place / station within 900 m), else the street; repeats get a number."""
        near = min(places, key=lambda p: dist_m((p["lat"], p["lon"]), (lat, lon))) if places else None
        if near and dist_m((near["lat"], near["lon"]), (lat, lon)) < 900:
            nm = near["name"]
        else:
            x, y = proj.xy(lat, lon)
            _, idx = G.edge_tree.query([float(x), float(y)], k=60)
            nm = next((G.ename[e] for e in idx if G.ename[e]), None) or "Bus stop"
        used[nm] = used.get(nm, 0) + 1
        return nm if used[nm] == 1 else f"{nm} {used[nm]}"
    cost = G.elen / np.where(G.is_main, 1.6, 1.0)          # buses prefer main roads
    out = []
    for k, spec in enumerate(ESTIMATED):
        nodes = [G.nearest_node(lat, lon)[0] for _, lat, lon in spec["via"]]
        path = []
        for a, b in zip(nodes, nodes[1:]):
            p = G.shortest_path(a, b, cost)
            if p is None:
                print(f"  {spec['id']}: no road between waypoints, skipped")
                path = None
                break
            path += p
        if not path:
            continue
        coords = G.path_coords(path)                          # [[lon, lat], ...]
        pts = [(c[1], c[0]) for c in coords]
        cum = [0.0]
        for a, b in zip(pts, pts[1:]):
            cum.append(cum[-1] + dist_m(a, b))
        stops: list[tuple[float, dict]] = []
        for name, lat, lon in spec["via"]:                    # waypoints are stops (real names)
            i = min(range(len(pts)), key=lambda i: dist_m(pts[i], (lat, lon)))
            real = next((p for p in osm_stops if dist_m((p["lat"], p["lon"]), (lat, lon)) < 80), None)
            stops.append((cum[i], {"id": real["id"] if real else f"e{spec['id']}-{name}", "name": name,
                                   "lat": real["lat"] if real else lat, "lon": real["lon"] if real else lon, **({} if real else {"est": True})}))
        for p in osm_stops:                                   # real OSM stops on the way
            i = min(range(len(pts)), key=lambda i: dist_m(pts[i], (p["lat"], p["lon"])))
            if dist_m(pts[i], (p["lat"], p["lon"])) < 120 and all(abs(cum[i] - s[0]) > 250 for s in stops):
                stops.append((cum[i], {"id": p["id"], "name": p.get("name") or "Bus stop", "lat": p["lat"], "lon": p["lon"]}))
        stops.sort(key=lambda s: s[0])
        used = {st["name"]: 1 for _, st in stops}
        filled = [stops[0]]                                   # estimated stops in the gaps
        for s in stops[1:]:
            gap = s[0] - filled[-1][0]
            nfill = int(gap // spec["stop_every_m"])
            base = filled[-1][0]
            for j in range(1, nfill + 1):
                pos = base + gap * j / (nfill + 1)
                i = min(range(len(cum)), key=lambda i: abs(cum[i] - pos))
                lat, lon = pts[i]
                filled.append((pos, {"id": f"e{spec['id']}-{len(filled)}", "name": stop_name(lat, lon, used), "lat": round(lat, 6), "lon": round(lon, 6), "est": True}))
            filled.append(s)
        seq = [s for _, s in filled]
        pos = [p for p, _ in filled]
        seg_s = [round((b - a) / BUS_SPEED_MPS + DWELL_S) for a, b in zip(pos, pos[1:])]
        out.append({"id": spec["id"], "name": f"{spec['id']}: {spec['name']} (estimated)", "mode": "bus",
                    "color": BUS_COLORS[k % len(BUS_COLORS)], "stops": seq, "seg_s": seg_s, "dwell_s": DWELL_S, "both_directions": True,
                    "service": [], "hours_known": False, "headway_min": spec["headway_min"], "source": "estimated", "synthetic": True,
                    "note": ESTIMATED_HEADWAY_NOTE, "shape": [[round(c[0], 6), round(c[1], 6)] for c in coords[::3]]})
        print(f"  estimated {spec['id']}: {len(seq)} stops ({sum(1 for s in seq if s.get('est'))} estimated), {cum[-1] / 1000:.1f} km, every ~{spec['headway_min']} min, hours unknown")
    return out


def main():
    proj = LocalProjection(CFG["center"]["lat"], CFG["center"]["lon"])
    pois = read_json(DATA / "pois.json")["pois"]
    osm, report = osm_routes(proj)
    manual = manual_routes(pois)
    routes = osm + manual
    ok, why = coverage_ok(routes)
    print(f"  coverage test (buses): {'PASS' if ok else 'FAIL'}: {why}")
    if not ok:
        G = RoadGraph(load_pack(DATA / "graph_drive.json.gz"), proj, "drive")
        routes += estimated_routes(G, proj, pois)
    write_json(DATA / "transit_schedule.json", {
        "generated_at": utc_now_iso(),
        "synthetic": any(r["synthetic"] for r in routes),
        "source": "OpenStreetMap route relations" + (" + manual CSV" if manual else "") + ("" if ok else " + ESTIMATED bus routes (hours unknown)"),
        "coverage": {"buses_ok": ok, "detail": why, "osm": report},
        "routes": routes})


if __name__ == "__main__":
    main()

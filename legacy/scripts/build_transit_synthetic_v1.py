"""Build data/transit_schedule.json: illustrative night bus routes laid over REAL
OSM bus-stop locations, plus the metro lines with their (approximate) public
operating hours.

The demo city has no open GTFS feed, so timetables here are hand-built and the
file is labelled synthetic. Real GTFS can replace it later (same JSON shape).

    python scripts/build_transit.py
"""
from __future__ import annotations

import math
import sys

import numpy as np

from common import BACKEND, CFG, DATA, read_json, utc_now_iso, write_json

sys.path.insert(0, str(BACKEND))
from app.adapters.geo import LocalProjection  # noqa: E402
from app.adapters.osm import RoadGraph, load_pack  # noqa: E402

BUS_SPEED_MPS = 7.0     # ~25 km/h average incl. stops at night
DWELL_S = 20

# Night bus service patterns (hand-built). Times run across midnight in night order.
BUS_PATTERNS = [
    {"service": [{"from": "21:00", "to": "00:00", "headway_min": 20},
                 {"from": "00:00", "to": "02:40", "headway_min": 30}], "note": "last trip 02:40"},
    {"service": [{"from": "21:00", "to": "05:30", "headway_min": 40}], "note": "runs all night"},
    {"service": [{"from": "21:00", "to": "01:30", "headway_min": 30},
                 {"from": "05:00", "to": "07:00", "headway_min": 20}], "note": "gap 01:30-05:00"},
    {"service": [{"from": "21:00", "to": "05:30", "headway_min": 60}], "note": "hourly all night"},
]
ANCHORS = [(315, 135), (45, 225)]
COLORS = ["#f59e0b", "#22d3ee", "#a78bfa", "#34d399", "#fb7185", "#facc15", "#60a5fa"]
# persona corridors get a pattern each, so every demo persona has a realistic bus option
PERSONA_PATTERN = {"late_shift": 0, "iiit_student": 1, "railway_porter": 3}

METRO_LINES: list[dict] = []     # Nagpur Metro lines come from OSM route relations (UPGRADE U4)
METRO_SERVICE = [{"from": "05:30", "to": "23:15", "headway_min": 8}]


def dedupe_stops(stops, proj, radius=60.0):
    out = []
    for s in sorted(stops, key=lambda s: (s["name"] is None, s["id"])):
        x, y = proj.xy(s["lat"], s["lon"])
        if any(math.hypot(x - o["x"], y - o["y"]) < radius for o in out):
            continue
        out.append({**s, "x": float(x), "y": float(y)})
    return out


def stop_name_from_road(G: RoadGraph, stop, k):
    _, idx = G.edge_tree.query([stop["x"], stop["y"]], k=12)
    for e in idx:
        if G.ename[e]:
            return f"{G.ename[e]} stop"
    return f"Stop {k + 1}"


def nearest_stop(sx, sy, stops, x, y):
    d = np.hypot(sx - x, sy - y)
    named = [i for i in np.argsort(d)[:6] if stops[i]["name"] and d[i] < d.min() + 250]
    return int(named[0] if named else np.argmin(d))


def route_waypoints(stops, proj, pois):
    """(stop waypoints, pattern_index): persona corridors first, then cross-town routes."""
    sx = np.array([s["x"] for s in stops])
    sy = np.array([s["y"] for s in stops])
    by_name = {p["name"]: p for p in pois if p.get("name")}
    out = []
    for per in CFG.get("personas", []):
        o = per.get("origin_at") or by_name.get(per["origin"])
        h = per.get("home_at") or by_name.get(per["home"])
        if not o or not h:
            continue
        ox, oy = proj.xy(o["lat"], o["lon"])
        hx, hy = proj.xy(h["lat"], h["lon"])
        v = np.array([hx - ox, hy - oy])
        v = v / max(np.linalg.norm(v), 1.0)
        wps = [nearest_stop(sx, sy, stops, ox - v[0] * 900, oy - v[1] * 900),   # terminal beyond origin
               nearest_stop(sx, sy, stops, ox, oy),                             # serves the workplace
               nearest_stop(sx, sy, stops, hx, hy),                             # serves home
               nearest_stop(sx, sy, stops, hx + v[0] * 900, hy + v[1] * 900)]   # terminal beyond home
        wps = [w for k, w in enumerate(wps) if k == 0 or w != wps[k - 1]]
        if len(set(wps)) >= 2:
            out.append((wps, PERSONA_PATTERN.get(per["id"], 1)))
    # cross-town routes inside each full-detail zone (the area is zones, not one circle)
    for z in CFG.get("area", {}).get("zones", []):
        zx, zy = proj.xy(z["lat"], z["lon"])
        R = z["radius_m"] * 0.75
        for k, (a_deg, b_deg) in enumerate(ANCHORS):
            pair = [nearest_stop(sx, sy, stops, zx + R * math.sin(math.radians(d)), zy + R * math.cos(math.radians(d)))
                    for d in (a_deg, b_deg)]
            if pair[0] != pair[1]:
                out.append((pair, 3 if k else 1))
    return out


def build_bus_routes(G: RoadGraph, stops, proj, pois):
    routes = []
    cost = G.elen / np.where(G.is_main, 1.6, 1.0)          # buses prefer main roads
    for ri, (wps, pat_i) in enumerate(route_waypoints(stops, proj, pois)):
        nodes = [G.nearest_node(stops[w]["lat"], stops[w]["lon"])[0] for w in wps]
        path, ok = [], True
        for na, nb in zip(nodes, nodes[1:]):
            p = G.shortest_path(na, nb, cost)
            if p is None:
                ok = False
                break
            path += p
        if not ok or not path:
            continue
        coords = G.path_coords(path)
        px, py = proj.xy([c[1] for c in coords], [c[0] for c in coords])
        seg = np.hypot(np.diff(px), np.diff(py))
        cum = np.r_[0, np.cumsum(seg)]
        forced = set(wps)
        picked = []
        for i, s in enumerate(stops):
            d = np.hypot(px - s["x"], py - s["y"])
            j = int(np.argmin(d))
            if d[j] < 70 or i in forced:
                picked.append((cum[j], i))
        picked.sort()
        seq, last = [], -1e9
        for pos, i in picked:
            if pos - last >= 300 or i in forced:
                if seq and i in forced and pos - last < 300 and seq[-1][1] not in forced:
                    seq.pop()
                seq.append((pos, i))
                last = pos
        if len(seq) < 4:
            continue
        rid = f"N{len(routes) + 1}"
        pat = BUS_PATTERNS[pat_i]
        st = [{"id": stops[i]["id"], "name": stops[i]["name"] or stop_name_from_road(G, stops[i], k),
               "lat": stops[i]["lat"], "lon": stops[i]["lon"]} for k, (_, i) in enumerate(seq)]
        seg_s = [round((seq[k + 1][0] - seq[k][0]) / BUS_SPEED_MPS + DWELL_S) for k in range(len(seq) - 1)]
        routes.append({
            "id": rid, "name": f"Night bus {rid}: {st[0]['name']} - {st[-1]['name']}", "mode": "bus",
            "color": COLORS[ri % len(COLORS)], "stops": st, "seg_s": seg_s, "dwell_s": DWELL_S,
            "service": pat["service"], "note": pat["note"], "both_directions": True,
            "shape": [[round(c[0], 6), round(c[1], 6)] for c in coords[::2]],
        })
        print(f"  {rid}: {len(st)} stops, {cum[-1] / 1000:.1f} km, {pat['note']}")
    return routes


def build_metro(pois, proj):
    lines = []
    by_name = {}
    for p in pois:
        if p["cat"] == "metro_station" and p.get("name"):
            by_name.setdefault(p["name"], p)
    for line in METRO_LINES:
        st = []
        for nm in line["stations"]:
            p = by_name.get(nm) or next((v for k, v in by_name.items() if k.startswith(nm)), None)
            if p:
                st.append({"id": p["id"], "name": nm, "lat": p["lat"], "lon": p["lon"]})
        if len(st) < 2:
            continue
        seg_s = []
        for a, b in zip(st, st[1:]):
            ax, ay = proj.xy(a["lat"], a["lon"])
            bx, by = proj.xy(b["lat"], b["lon"])
            seg_s.append(round(math.hypot(bx - ax, by - ay) / 11.0 + 30))
        lines.append({"id": line["id"], "name": line["name"], "mode": "metro", "color": line["color"],
                      "stops": st, "seg_s": seg_s, "dwell_s": 30, "service": METRO_SERVICE,
                      "note": "approximate public operating hours; no night service", "both_directions": True,
                      "shape": [[s["lon"], s["lat"]] for s in st]})
        print(f"  {line['id']}: {len(st)} stations")
    return lines


def main():
    proj = LocalProjection(CFG["center"]["lat"], CFG["center"]["lon"])
    G = RoadGraph(load_pack(DATA / "graph_drive.json.gz"), proj, "drive")
    pois = read_json(DATA / "pois.json")["pois"]
    stops = dedupe_stops([p for p in pois if p["cat"] == "bus_stop"], proj)
    print(f"  {len(stops)} distinct bus stops")
    routes = build_bus_routes(G, stops, proj, pois) + build_metro(pois, proj)
    write_json(DATA / "transit_schedule.json", {
        "generated_at": utc_now_iso(), "synthetic": True,
        "source": "hand-built illustrative timetable on real OpenStreetMap stop locations",
        "routes": routes})


if __name__ == "__main__":
    main()

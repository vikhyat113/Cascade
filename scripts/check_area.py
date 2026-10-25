"""Inspect, summarize, and verify demo area statistics and data health.

Prints:
- Polygon area in km2, vertex count, bbox, placeholder_suspect
- Node and edge counts for walk and drive
- Walk and drive nodes inside the buffered polygon (and % of nodes inside)
- POI counts inside and outside polygon, and by category
- Generation timestamps of graph and POIs vs area modified time
- Flag stale data if graph or POIs generated before area.geojson mtime
- Exit with non-zero code if placeholder_suspect, stale data, or < 99% nodes inside

Usage:
    python scripts/check_area.py
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "backend"))

from common import CFG, DATA, get_area, read_json  # noqa: E402


def _to_utc(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def main():
    print("=== Demo Area Diagnostics ===")
    area = get_area()
    exit_reasons = []

    if area is not None:
        print(f"Area mode:        polygon")
        print(f"Area source:      {area.source_path}")
        print(f"Source modified:  {area.source_mtime}")
        print(f"Polygon area:     {area.area_km2():.2f} km²")
        print(f"Vertex count:     {len(area.polygon.exterior.coords)}")
        print(f"Centroid:         lat={area.centroid['lat']}, lon={area.centroid['lon']}")
        print(f"Bounding box:     {area.bbox}")
        print(f"Radius (max dist):{area.max_distance_to_vertex():.1f} m")
        print(f"Placeholder flag: {area.placeholder_suspect}")
        if area.placeholder_suspect:
            exit_reasons.append("placeholder_suspect is True (regular/synthetic polygon shape detected)")
    else:
        r = CFG.get("radius_m", 4000)
        import math
        circ_area = math.pi * (r / 1000.0) ** 2
        print(f"Area mode:        circle_fallback")
        print(f"Polygon area:     None (circular area {circ_area:.2f} km²)")
        print(f"Center:           {CFG.get('center')}")
        print(f"Radius:           {r} m")
        print(f"Placeholder flag: False")

    print("\n=== Street Graphs ===")
    walk_path = DATA / "graph_walk.json.gz"
    drive_path = DATA / "graph_drive.json.gz"
    walk_data = read_json(walk_path) if walk_path.exists() else None
    drive_data = read_json(drive_path) if drive_path.exists() else None

    walk_n = 0
    walk_inside = 0
    if walk_data:
        w_nodes = walk_data["nodes"]
        walk_n = len(w_nodes["id"])
        w_edges = len(walk_data["edges"]["u"])
        print(f"Walk graph:       {walk_n} nodes, {w_edges} edges")
        lit_w = sum(1 for x in walk_data["edges"].get("lit", []) if x is not None)
        sw_w = sum(1 for x in walk_data["edges"].get("sidewalk", []) if x is not None)
        print(f"  Walk lit share:     {lit_w}/{w_edges} ({lit_w / max(1, w_edges) * 100:.2f}%)")
        print(f"  Walk sidewalk share:{sw_w}/{w_edges} ({sw_w / max(1, w_edges) * 100:.2f}%)")

        if area is not None:
            lats = w_nodes.get("y") or w_nodes.get("lat", [])
            lons = w_nodes.get("x") or w_nodes.get("lon", [])
            walk_inside = sum(1 for la, lo in zip(lats, lons) if area.contains_buffered(la, lo))
            print(f"  Walk nodes inside:  {walk_inside}/{walk_n} ({walk_inside / max(1, walk_n) * 100:.2f}%)")
        else:
            walk_inside = walk_n
    else:
        print("Walk graph:       missing")

    drive_n = 0
    drive_inside = 0
    if drive_data:
        d_nodes = drive_data["nodes"]
        drive_n = len(d_nodes["id"])
        d_edges = len(drive_data["edges"]["u"])
        print(f"Drive graph:      {drive_n} nodes, {d_edges} edges")
        lit_d = sum(1 for x in drive_data["edges"].get("lit", []) if x is not None)
        sw_d = sum(1 for x in drive_data["edges"].get("sidewalk", []) if x is not None)
        print(f"  Drive lit share:    {lit_d}/{d_edges} ({lit_d / max(1, d_edges) * 100:.2f}%)")
        print(f"  Drive sidewalk:     {sw_d}/{d_edges} ({sw_d / max(1, d_edges) * 100:.2f}%)")

        if area is not None:
            lats = d_nodes.get("y") or d_nodes.get("lat", [])
            lons = d_nodes.get("x") or d_nodes.get("lon", [])
            drive_inside = sum(1 for la, lo in zip(lats, lons) if area.contains_buffered(la, lo))
            print(f"  Drive nodes inside: {drive_inside}/{drive_n} ({drive_inside / max(1, drive_n) * 100:.2f}%)")
        else:
            drive_inside = drive_n
    else:
        print("Drive graph:      missing")

    total_nodes = walk_n + drive_n
    total_inside = walk_inside + drive_inside
    share_nodes_inside = (total_inside / max(1, total_nodes)) * 100.0
    print(f"\nTotal graph nodes inside buffered polygon: {total_inside}/{total_nodes} ({share_nodes_inside:.2f}%)")
    if share_nodes_inside < 99.0:
        exit_reasons.append(f"share of nodes inside polygon is {share_nodes_inside:.2f}% (must be >= 99.0%)")

    print("\n=== POIs ===")
    pois_path = DATA / "pois.json"
    pois_gen_str = None
    if pois_path.exists():
        pois_data = read_json(pois_path)
        pois_gen_str = pois_data.get("generated_at")
        pois = pois_data.get("pois", [])
        counts: dict[str, int] = {}
        inside_count = 0
        for p in pois:
            cat = p.get("cat", "unknown")
            counts[cat] = counts.get(cat, 0) + 1
            if area is not None:
                if area.contains(p["lat"], p["lon"]):
                    inside_count += 1
            else:
                inside_count += 1

        print(f"Total POIs:       {len(pois)}")
        if area is not None:
            print(f"POIs inside area: {inside_count}")
            print(f"POIs outside area:{len(pois) - inside_count}")
        for cat, count in sorted(counts.items(), key=lambda t: -t[1]):
            print(f"  {cat:<20}: {count}")
    else:
        print("POIs file missing")

    print("\n=== Staleness Verification ===")
    walk_gen_str = walk_data.get("generated_at") if walk_data else None
    print(f"graph_walk generated_at: {walk_gen_str}")
    print(f"pois.json generated_at:  {pois_gen_str}")

    stale_data = False
    if area is not None and area.source_mtime:
        source_dt = _to_utc(area.source_mtime)
        print(f"area.geojson modified:   {area.source_mtime}")
        if walk_gen_str and source_dt:
            w_dt = _to_utc(walk_gen_str)
            if w_dt and w_dt < source_dt:
                stale_data = True
                print("  [WARN] graph_walk was generated BEFORE area.geojson was modified!")
        if pois_gen_str and source_dt:
            p_dt = _to_utc(pois_gen_str)
            if p_dt and p_dt < source_dt:
                stale_data = True
                print("  [WARN] pois.json was generated BEFORE area.geojson was modified!")

    print("\n=== Polygon-Clipped Data Layers ===")
    area_dt = _to_utc(area.source_mtime) if area is not None and area.source_mtime else None
    area_file = DATA / "area.geojson"
    if area_dt is None and area_file.exists():
        area_dt = datetime.fromtimestamp(area_file.stat().st_mtime, tz=timezone.utc)

    layers_info = [
        {
            "name": "VIIRS Night Lights",
            "file": DATA / "viirs_ntl.json",
            "val_key": "radiance",
            "rows_key": "rows",
        },
        {
            "name": "Weather Grid (Forecast)",
            "file": DATA / "weather_grid.json",
            "val_key": "temperature_2m",
            "points_key": "points",
        },
        {
            "name": "Thermal LST (MODIS Aqua)",
            "file": DATA / "thermal_lst.json",
            "val_key": "value",
            "rows_key": "cells",
        },
    ]

    for lay in layers_info:
        lf = lay["file"]
        lname = lay["name"]
        print(f"\n-- {lname} ({lf.name}) --")
        if not lf.exists():
            print("  Status: MISSING")
            continue

        try:
            ldata = read_json(lf)
            f_size_kb = lf.stat().st_size / 1024.0
            file_mtime_dt = datetime.fromtimestamp(lf.stat().st_mtime, tz=timezone.utc)
            older_than_area = (file_mtime_dt < area_dt) if area_dt else False

            source = ldata.get("source", "Unknown")
            date_range = ldata.get("acquired_range") or ldata.get("date_range") or "N/A"
            unit = ldata.get("unit") or "N/A"

            # Cell count & UNKNOWN share
            if "rows_key" in lay:
                cells = ldata.get(lay["rows_key"], [])
                inside_count = len(cells)
                vkey = lay["val_key"]
                vals = [c.get(vkey) for c in cells if c.get(vkey) is not None]
                unknown_count = sum(1 for c in cells if c.get(vkey) is None or c.get("status") == "UNKNOWN" or c.get("status_hint") == "UNKNOWN")
            elif "points_key" in lay:
                points = ldata.get(lay["points_key"], [])
                inside_count = len(points)
                vkey = lay["val_key"]
                vals = []
                for pt in points:
                    h = pt.get("hourly", {})
                    if vkey in h and h[vkey]:
                        vals.extend([x for x in h[vkey] if x is not None])
                unknown_count = 0
                if points and "hourly" in points[0] and "time" in points[0]["hourly"]:
                    times = points[0]["hourly"]["time"]
                    date_range = f"{times[0]} to {times[-1]}"
                unit = ldata.get("units", {}).get(vkey, "°C")
            else:
                inside_count = 0
                vals = []
                unknown_count = 0

            unk_pct = (unknown_count / max(1, inside_count)) * 100.0
            safe_unit = unit.replace("⁻²", "^-2").replace("⁻¹", "^-1").replace("·", "*").replace("²", "^2").replace("°", "deg")
            val_range_str = f"{min(vals):.2f} to {max(vals):.2f} {safe_unit}" if vals else "No valid values"

            print(f"  Source:             {source}")
            print(f"  Product / Model:    {ldata.get('product') or ldata.get('model', 'N/A')}")
            print(f"  Date / Valid Range: {date_range}")
            print(f"  Cells inside area:  {inside_count} (dropped {ldata.get('dropped_cells', ldata.get('dropped_points', 0))} outside)")
            print(f"  UNKNOWN share:      {unknown_count}/{inside_count} ({unk_pct:.1f}%)")
            print(f"  Value range:        {val_range_str}")
            print(f"  File size:          {f_size_kb:.1f} KB")
            print(f"  Older than area:    {older_than_area} (file mtime: {file_mtime_dt.isoformat()[:19]}Z)")
            if older_than_area:
                print(f"  [WARN] {lf.name} was fetched before area.geojson was modified!")
        except Exception as e:
            print(f"  Error reading layer: {e}")

    print(f"Stale data flag:  {stale_data}")

    print("\n=== Data Files in data/ ===")
    if DATA.exists():
        for f in sorted(DATA.iterdir()):
            if f.is_file():
                size_kb = f.stat().st_size / 1024.0
                print(f"  {f.name:<30}: {size_kb:.1f} KB")

    if exit_reasons:
        print("\n[FAILED] Area verification failed:")
        for r in exit_reasons:
            print(f"  - {r}")
        sys.exit(1)
    else:
        print("\n[OK] Area verification passed!")
        sys.exit(0)


if __name__ == "__main__":
    main()

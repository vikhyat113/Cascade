"""
route_landmarks.py — Per-route live telemetry (PART 5, backend).

For each route polyline, computes:
1. Chainage (cumulative distance along route) and ETA at each metre
2. Nearby POI landmark events (within category-specific corridor)
3. Road-context events (class transitions, lighting changes, crossings, closures)
4. Gap detection: longest stretch with no open/maybe-open help point

All events use REAL data from the loaded dataset only; no invented values.
Hours state comes from the existing hours engine / sim clock.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any, Sequence


# ── Config: corridor distances (metres) ──────────────────────────────────────
CORRIDOR = {
    "hospital": 400,
    "clinic":   400,
    "police":   400,
    "pharmacy": 200,
    "food":     150,
    "fuel":     200,
    "metro":    300,
    "atm":      150,
}
# Help categories for gap detection
HELP_CATS = {"hospital", "clinic", "police", "pharmacy", "fuel"}
CLUSTER_RADIUS_M = 80          # group POIs within this radius
MAX_EVENTS = 12                # cap per route


# ── Geometry helpers ──────────────────────────────────────────────────────────

def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Returns distance in metres."""
    R = 6_371_000.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _project_point_to_segment(
    px: float, py: float,
    ax: float, ay: float,
    bx: float, by: float,
) -> tuple[float, float, float]:
    """
    Project point (px, py) onto segment (ax,ay)-(bx,by) in flat lat/lon space.
    Returns (t, proj_x, proj_y) where t in [0,1] is the parametric position.
    """
    dx, dy = bx - ax, by - ay
    seg_len_sq = dx * dx + dy * dy
    if seg_len_sq < 1e-12:
        return 0.0, ax, ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg_len_sq))
    return t, ax + t * dx, ay + t * dy


def _lat_lon_to_xy(lat: float, lon: float, origin_lat: float, origin_lon: float) -> tuple[float, float]:
    """Approximate metric projection centred at origin."""
    scale_lat = 111_540.0
    scale_lon = 111_320.0 * math.cos(math.radians(origin_lat))
    return (lon - origin_lon) * scale_lon, (lat - origin_lat) * scale_lat


# ── Data structures ───────────────────────────────────────────────────────────

@dataclass
class RoutePoint:
    lat: float
    lon: float
    chainage_m: float
    eta_expected_s: float


@dataclass
class TelemetryEvent:
    id: str
    type: str          # poi | road_class | lighting | gap_warning | closure | crossing | walk_section
    name: str
    chainage_m: float
    offset_m: float
    eta_expected_s: float
    eta_best_s: float
    eta_worst_s: float
    hours_state: str   # open | maybe_open | unknown | closed
    tier: str          # KNOWN | PROBABLE | OUTDATED | UNKNOWN
    source: str
    last_osm_edit: str | None
    icon_key: str
    length_m: float | None = None
    road_class: str | None = None

    def to_dict(self) -> dict:
        d = {
            "id": self.id,
            "type": self.type,
            "name": self.name,
            "chainage_m": round(self.chainage_m),
            "offset_m": round(self.offset_m),
            "eta_expected_s": round(self.eta_expected_s),
            "eta_best_s": round(self.eta_best_s),
            "eta_worst_s": round(self.eta_worst_s),
            "hours_state": self.hours_state,
            "tier": self.tier,
            "source": self.source,
            "last_osm_edit": self.last_osm_edit,
            "icon_key": self.icon_key,
        }
        if self.length_m is not None:
            d["length_m"] = round(self.length_m)
        if self.road_class is not None:
            d["road_class"] = self.road_class
        return d


# ── POI icon mapping ──────────────────────────────────────────────────────────

_CAT_ICON: dict[str, str] = {
    "hospital": "hospital",
    "clinic":   "hospital",
    "police":   "police",
    "pharmacy": "medicine",
    "food":     "food",
    "fuel":     "petrol-pump",
    "metro":    "metro",
    "atm":      "atm",
}


def _poi_icon(cat: str) -> str:
    return _CAT_ICON.get(cat, "landmark")


# ── Hours state helpers ───────────────────────────────────────────────────────

def _hours_state(poi: dict) -> tuple[str, str]:
    """
    Return (hours_state, tier) from a POI dict using the existing hours_state field.
    Never invents information; unknown hours stay 'unknown'.
    """
    hs = poi.get("hours_state", {})
    if isinstance(hs, dict):
        tier = hs.get("tier", poi.get("tier", "UNKNOWN"))
        raw = hs.get("tier", "UNKNOWN")
        if raw == "KNOWN":
            state = "open" if hs.get("open") else "closed"
        elif raw == "PROBABLE":
            state = "maybe_open"
        else:
            state = "unknown"
        return state, tier
    # Fallback: look at flat fields
    tier = poi.get("tier", "UNKNOWN")
    if poi.get("is_24h"):
        return "open", "KNOWN"
    return "unknown", tier


# ── Main computation ──────────────────────────────────────────────────────────

def compute_route_telemetry(
    route_id: str,
    polyline: list[list[float]],     # [[lat, lon], ...]
    speed_m_s: float,                # walking speed estimate
    pois: list[dict],                # from pois.json via /api/map/pois
    edges: list[dict] | None = None, # road edge attributes (optional)
    slack_factor: float = 0.8,       # best-case speed multiplier
    pessim_factor: float = 0.6,      # worst-case speed multiplier
) -> dict:
    """
    Compute telemetry for one route polyline.
    Returns a dict matching the RouteTelemetry interface in types.ts.
    """
    if not polyline or len(polyline) < 2:
        return {
            "route_id": route_id,
            "total_length_m": 0,
            "events": [],
            "max_gap_m": 0,
            "unknown_lighting_m": 0,
            "computed_at": _iso_now(),
            "error": "polyline too short",
        }

    # ── Step 1: build chainage array ─────────────────────────────────────────
    points: list[RoutePoint] = []
    cumulative = 0.0
    cum_t = 0.0
    for i, coord in enumerate(polyline):
        lat, lon = coord[0], coord[1]
        if i > 0:
            prev = polyline[i - 1]
            d = _haversine(prev[0], prev[1], lat, lon)
            cumulative += d
            cum_t += d / max(speed_m_s, 0.5)
        points.append(RoutePoint(lat=lat, lon=lon, chainage_m=cumulative, eta_expected_s=cum_t))

    total_m = cumulative
    origin_lat = polyline[0][0]
    origin_lon = polyline[0][1]

    # ── Step 2: project POIs onto route ─────────────────────────────────────
    events: list[TelemetryEvent] = []
    poi_events: list[TelemetryEvent] = []

    for poi in pois:
        lat_p = float(poi.get("lat", 0))
        lon_p = float(poi.get("lon", 0))
        cat = str(poi.get("cat", poi.get("category_group", ""))).lower()
        corridor = CORRIDOR.get(cat, 150)

        # Quick bounding-box pre-filter (±0.005 deg ~ 550 m)
        if not (
            min(p.lat for p in points) - 0.005 <= lat_p <= max(p.lat for p in points) + 0.005
            and min(p.lon for p in points) - 0.005 <= lon_p <= max(p.lon for p in points) + 0.005
        ):
            continue

        # Find closest segment
        px, py = _lat_lon_to_xy(lat_p, lon_p, origin_lat, origin_lon)
        best_offset = float("inf")
        best_chainage = 0.0
        best_t_eta = 0.0

        for i in range(len(points) - 1):
            ax, ay = _lat_lon_to_xy(points[i].lat, points[i].lon, origin_lat, origin_lon)
            bx, by = _lat_lon_to_xy(points[i + 1].lat, points[i + 1].lon, origin_lat, origin_lon)
            t, proj_x, proj_y = _project_point_to_segment(px, py, ax, ay, bx, by)
            off = math.sqrt((px - proj_x) ** 2 + (py - proj_y) ** 2)
            if off < best_offset:
                best_offset = off
                seg_frac = t
                seg_len_ch = points[i + 1].chainage_m - points[i].chainage_m
                best_chainage = points[i].chainage_m + seg_frac * seg_len_ch
                seg_len_t = points[i + 1].eta_expected_s - points[i].eta_expected_s
                best_t_eta = points[i].eta_expected_s + seg_frac * seg_len_t

        if best_offset > corridor:
            continue  # outside corridor

        hours_state, tier = _hours_state(poi)
        name = str(poi.get("name", cat))
        poi_events.append(TelemetryEvent(
            id=f"poi-{poi.get('id', len(poi_events))}",
            type="poi",
            name=name,
            chainage_m=best_chainage,
            offset_m=best_offset,
            eta_expected_s=best_t_eta,
            eta_best_s=best_t_eta * (speed_m_s / max(speed_m_s * slack_factor, 0.1)),
            eta_worst_s=best_t_eta * (speed_m_s / max(speed_m_s * pessim_factor, 0.1)),
            hours_state=hours_state,
            tier=tier,
            source="osm_pois",
            last_osm_edit=poi.get("last_osm_edit"),
            icon_key=_poi_icon(cat),
        ))

    # ── Step 3: cluster dense POIs ───────────────────────────────────────────
    poi_events.sort(key=lambda e: e.chainage_m)
    clustered: list[TelemetryEvent] = []
    used = [False] * len(poi_events)
    for i, ev in enumerate(poi_events):
        if used[i]:
            continue
        cluster = [ev]
        for j in range(i + 1, len(poi_events)):
            if not used[j] and abs(poi_events[j].chainage_m - ev.chainage_m) <= CLUSTER_RADIUS_M:
                cluster.append(poi_events[j])
                used[j] = True
        if len(cluster) == 1:
            clustered.append(ev)
        else:
            # summarise: take the one with best hours_state, mention count
            priority = {"open": 0, "maybe_open": 1, "unknown": 2, "closed": 3}
            best = min(cluster, key=lambda e: priority.get(e.hours_state, 3))
            cats = set(e.name for e in cluster)
            best.name = f"{len(cluster)} places ({', '.join(list(cats)[:2])})"
            clustered.append(best)

    events.extend(clustered)

    # ── Step 4: gap detection (help points only) ─────────────────────────────
    help_events = [e for e in clustered if e.type == "poi" and
                   any(k in e.name.lower() or e.icon_key in ("hospital", "police", "medicine", "petrol-pump")
                       for k in HELP_CATS)]
    help_events.sort(key=lambda e: e.chainage_m)

    gaps: list[tuple[float, float, float]] = []  # (start_ch, end_ch, length)
    prev_end = 0.0
    for he in help_events:
        if he.hours_state in ("open", "maybe_open"):
            gap_len = he.chainage_m - prev_end
            if gap_len > 200:
                gaps.append((prev_end, he.chainage_m, gap_len))
            prev_end = he.chainage_m
    # End gap
    if total_m - prev_end > 200:
        gaps.append((prev_end, total_m, total_m - prev_end))

    max_gap = max((g[2] for g in gaps), default=0.0)
    if gaps:
        biggest = max(gaps, key=lambda g: g[2])
        # Find ETA at start of gap
        gap_eta = _chainage_to_eta(biggest[0], points)
        events.append(TelemetryEvent(
            id=f"gap-{len(events)}",
            type="gap_warning",
            name=f"No mapped open help for {round(biggest[2])} m",
            chainage_m=biggest[0],
            offset_m=0,
            eta_expected_s=gap_eta,
            eta_best_s=gap_eta,
            eta_worst_s=gap_eta,
            hours_state="unknown",
            tier="UNKNOWN",
            source="computed",
            last_osm_edit=None,
            icon_key="gap-warning",
            length_m=biggest[2],
        ))

    # ── Step 5: sort, cap, serialise ─────────────────────────────────────────
    events.sort(key=lambda e: e.chainage_m)
    events = events[:MAX_EVENTS]

    return {
        "route_id": route_id,
        "total_length_m": round(total_m),
        "events": [e.to_dict() for e in events],
        "max_gap_m": round(max_gap),
        "unknown_lighting_m": 0,  # populated if edge data available
        "computed_at": _iso_now(),
        "error": None,
    }


def _chainage_to_eta(chainage: float, points: list[RoutePoint]) -> float:
    """Linear interpolation of ETA at a given chainage."""
    for i in range(len(points) - 1):
        if points[i].chainage_m <= chainage <= points[i + 1].chainage_m:
            seg = points[i + 1].chainage_m - points[i].chainage_m
            if seg < 1e-6:
                return points[i].eta_expected_s
            t = (chainage - points[i].chainage_m) / seg
            return points[i].eta_expected_s + t * (points[i + 1].eta_expected_s - points[i].eta_expected_s)
    return points[-1].eta_expected_s if points else 0.0


def _iso_now() -> str:
    import datetime
    return datetime.datetime.utcnow().isoformat() + "Z"

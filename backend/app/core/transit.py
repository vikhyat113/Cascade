"""Transit network: routes + trips for the demo night, expanded from
data/transit_schedule.json (hand-built, synthetic) or a real GTFS-derived file
with the same shape."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

import numpy as np

from ..adapters.geo import LocalProjection
from .clock import night_time


@dataclass
class Stop:
    id: str
    name: str
    lat: float
    lon: float
    x: float
    y: float


@dataclass
class Route:
    id: str
    name: str
    mode: str
    color: str
    stops: list[Stop]
    seg_s: list[int]
    service: list[dict]
    note: str = ""
    shape: list = field(default_factory=list)


@dataclass
class Trip:
    id: str
    route_id: str
    direction: str            # "A" forward, "B" reverse
    stop_pos: list[int]       # indices into route.stops, in travel order
    times: list[datetime]     # scheduled time at each stop, in travel order

    @property
    def start(self) -> datetime:
        return self.times[0]

    def pos_of(self, route_stop_index: int) -> Optional[int]:
        try:
            return self.stop_pos.index(route_stop_index)
        except ValueError:
            return None


class TransitNetwork:
    def __init__(self, schedule: dict, night: date, tz: ZoneInfo, proj: LocalProjection):
        self.synthetic = bool(schedule.get("synthetic", True))
        self.source_note = schedule.get("source", "")
        ga = schedule.get("generated_at")
        self.generated_at = datetime.fromisoformat(ga.replace("Z", "+00:00")) if ga else None
        self.routes: dict[str, Route] = {}
        self.trips: dict[str, Trip] = {}
        self.by_route_dir: dict[tuple[str, str], list[Trip]] = {}
        all_stops = []
        for r in schedule.get("routes", []):
            try:
                stops = []
                for s in r["stops"]:
                    x, y = proj.xy(s["lat"], s["lon"])
                    stops.append(Stop(s["id"], s["name"], s["lat"], s["lon"], float(x), float(y)))
                route = Route(r["id"], r["name"], r.get("mode", "bus"), r.get("color", "#999"), stops,
                              [int(v) for v in r["seg_s"]], r.get("service", []), r.get("note", ""),
                              r.get("shape", []))
            except (KeyError, TypeError, ValueError):
                continue
            if len(route.stops) < 2 or len(route.seg_s) != len(route.stops) - 1:
                continue
            self.routes[route.id] = route
            self._expand(route, night, tz, both=r.get("both_directions", True))
            for i, s in enumerate(stops):
                all_stops.append((route.id, i, s.x, s.y))
        self._stop_index = all_stops
        self._sx = np.array([s[2] for s in all_stops]) if all_stops else np.zeros(0)
        self._sy = np.array([s[3] for s in all_stops]) if all_stops else np.zeros(0)

    def _expand(self, route: Route, night: date, tz: ZoneInfo, both: bool) -> None:
        deps: set[datetime] = set()
        for w in route.service:
            start = night_time(w["from"], night, tz)
            end = night_time(w["to"], night, tz)
            if end < start:
                end += timedelta(days=1)
            t = start
            while t <= end:
                deps.add(t)
                t += timedelta(minutes=int(w["headway_min"]))
        n = len(route.stops)
        for direction in (("A", "B") if both else ("A",)):
            pos = list(range(n)) if direction == "A" else list(range(n - 1, -1, -1))
            segs = route.seg_s if direction == "A" else route.seg_s[::-1]
            trips = []
            for d in sorted(deps):
                times = [d]
                for s in segs:
                    times.append(times[-1] + timedelta(seconds=s))
                trip = Trip(f"{route.id}-{direction}-{d.strftime('%H%M')}", route.id, direction, pos, times)
                self.trips[trip.id] = trip
                trips.append(trip)
            self.by_route_dir[(route.id, direction)] = trips

    # ---- queries --------------------------------------------------------------
    def stops_near(self, x: float, y: float, radius: float) -> list[tuple[str, int, float]]:
        if len(self._sx) == 0:
            return []
        d = np.hypot(self._sx - x, self._sy - y)
        idx = np.nonzero(d <= radius)[0]
        return sorted(((self._stop_index[i][0], self._stop_index[i][1], float(d[i])) for i in idx),
                      key=lambda t: t[2])

    def trips_after(self, route_id: str, direction: str, stop_index: int, t: datetime,
                    limit: int = 6, lookback_s: int = 900) -> list[Trip]:
        out = []
        for trip in self.by_route_dir.get((route_id, direction), []):
            p = trip.pos_of(stop_index)
            if p is None:
                continue
            if trip.times[p] >= t - timedelta(seconds=lookback_s):
                out.append(trip)
                if len(out) >= limit:
                    break
        return out

    def service_windows(self, route_id: str) -> list[tuple[datetime, datetime]]:
        trips = self.by_route_dir.get((route_id, "A"), [])
        if not trips:
            return []
        windows, start, prev = [], trips[0].start, trips[0].start
        for tr in trips[1:]:
            if (tr.start - prev).total_seconds() > 3 * 3600 / 2:   # gap > 90 min
                windows.append((start, prev))
                start = tr.start
            prev = tr.start
        windows.append((start, prev))
        return windows

    def last_departure_before(self, route_id: str, t: datetime) -> Optional[datetime]:
        trips = [tr.start for tr in self.by_route_dir.get((route_id, "A"), []) if tr.start <= t]
        return max(trips) if trips else None

    def next_departure_after(self, route_id: str, t: datetime) -> Optional[datetime]:
        trips = [tr.start for tr in self.by_route_dir.get((route_id, "A"), []) if tr.start >= t]
        return min(trips) if trips else None


def load_transit(path: Path, night: date, tz: ZoneInfo, proj: LocalProjection) -> Optional[TransitNetwork]:
    if not path.exists():
        return None
    try:
        return TransitNetwork(json.loads(path.read_text(encoding="utf-8")), night, tz, proj)
    except (json.JSONDecodeError, ValueError):
        return None

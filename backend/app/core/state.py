"""WorldState: everything that changes while the engine runs.

  * store   - the latest Fact per key (what the planner is allowed to see)
  * sources - per data source: enabled/outage flag, last successful update
  * truth   - the simulator's ground truth (rain, closures, cancellations...).
              The planner NEVER reads truth; it only sees facts emitted by
              feeds, so outages genuinely hide what is happening.
"""
from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np

from .facts import Fact, FactView
from .freshness import confidence, status, view
from .world import StaticWorld

STATIC_SOURCES = ("osm_map", "osm_hours", "weather_forecast", "transit_schedule", "incident_history",
                  "viirs_ntl", "thermal_lst", "weather_grid")

CREDITS = {
    "osm_map": "© OpenStreetMap contributors (ODbL)",
    "osm_hours": "© OpenStreetMap contributors (ODbL)",
    "weather_forecast": "Weather data by Open-Meteo.com (CC BY 4.0)",
    "viirs_ntl": "NASA EOSDIS / Black Marble Science Team (Public Domain)",
    "thermal_lst": "NASA EOSDIS Land Processes DAAC / USGS (Public Domain)",
    "weather_grid": "Weather data by Open-Meteo.com (CC BY 4.0)",
}


@dataclass
class SourceState:
    id: str
    label: str
    kind: str
    ttl_s: int
    reliability: float
    synthetic: bool
    live: bool
    dropout: float = 0.0
    max_delay_s: float = 0.0
    coverage: float = 1.0
    enabled: bool = True
    last_ok: Optional[datetime] = None
    burst_until: Optional[datetime] = None
    emitted: int = 0
    history: deque = field(default_factory=lambda: deque(maxlen=40))
    last_status: Optional[str] = None


@dataclass
class SimTruth:
    rain: Optional[str] = None                 # override: none/light/moderate/heavy
    rain_since: Optional[datetime] = None
    fog: bool = False
    closures: dict = field(default_factory=dict)        # id -> {name, reason, walk_edges, drive_edges, lat, lon}
    lifted: dict = field(default_factory=dict)          # id -> lifted_at
    cancelled_trips: set = field(default_factory=set)
    cancel_route_from: dict = field(default_factory=dict)   # route_id -> datetime
    trip_delay: dict = field(default_factory=dict)          # trip_id -> seconds
    accidents: dict = field(default_factory=dict)           # traffic cell -> speed factor
    incidents: list = field(default_factory=list)           # live incident reports (truth)
    cab_multiplier: float = 1.0
    schedule_conflicts: dict = field(default_factory=dict)  # trip_id -> real delay (schedule wrong)


class WorldState:
    def __init__(self, static: StaticWorld, clock, seed: Optional[int] = None):
        self.static = static
        self.clock = clock
        self.fc = static.fc
        self.store: dict[str, Fact] = {}
        self.truth = SimTruth()
        self.rng = np.random.default_rng(static.seed if seed is None else seed)
        self.events: deque = deque(maxlen=400)
        self.event_seq = 0
        self.version = 0
        self.lock = threading.RLock()
        self.sources: dict[str, SourceState] = {}
        for sid, c in static.source_cfg.items():
            self.sources[sid] = SourceState(
                id=sid, label=c["label"], kind=c["kind"], ttl_s=int(c["ttl_s"]),
                reliability=float(c["reliability"]), synthetic=bool(c["synthetic"]), live=bool(c.get("live")),
                dropout=float(c.get("dropout", 0.0)), max_delay_s=float(c.get("max_delay_s", 0.0)),
                coverage=float(c.get("coverage", 1.0)))
        self._incident_seq = 0
        self._closure_seq = 0

        # Live weather initialization
        if getattr(static, "live_weather", False):
            if "weather_live" in self.sources:
                self.sources["weather_live"].synthetic = False
                self.sources["weather_live"].label = "Weather observations (Open-Meteo live)"
            adapter = getattr(static, "weather_live_adapter", None)
            if adapter:
                for f in adapter.build_facts(self.now()):
                    self.put(f)

    # ---- facts -------------------------------------------------------------------
    def now(self) -> datetime:
        return self.clock.now()

    def put(self, fact: Fact) -> None:
        self.store[fact.key] = fact

    def get(self, key: str) -> Optional[Fact]:
        return self.store.get(key)

    def with_prefix(self, prefix: str) -> list[Fact]:
        return [f for k, f in self.store.items() if k.startswith(prefix)]

    def view(self, fact: Optional[Fact], **kw) -> FactView:
        return view(fact, self.now(), self.fc, **kw)

    def status_of(self, fact: Optional[Fact]) -> str:
        return status(fact, self.now(), self.fc)

    def conf_of(self, fact: Optional[Fact]) -> float:
        return confidence(fact, self.now(), self.fc)

    # ---- sources ---------------------------------------------------------------------
    def available(self, sid: str) -> bool:
        s = self.sources.get(sid)
        return bool(s and s.enabled)

    def _static_observed_at(self, sid: str) -> Optional[datetime]:
        st = self.static
        return {
            "osm_map": st.map_generated_at,
            "osm_hours": st.pois_generated_at,
            "weather_forecast": st.weather.fetched_at,
            "transit_schedule": st.transit.generated_at if st.transit else None,
            "incident_history": st.incidents_generated_at,
            "viirs_ntl": getattr(st, "viirs_observed_at", None),
            "thermal_lst": getattr(st, "thermal_observed_at", None),
            "weather_grid": getattr(st, "weather_grid_observed_at", None),
        }.get(sid)

    def heartbeat(self, sid: str) -> Optional[Fact]:
        s = self.sources[sid]
        if s.live:
            if s.last_ok is None:
                return None
            obs = s.last_ok
        else:
            obs = self._static_observed_at(sid) if s.enabled else None
            if obs is None:
                return None
        return Fact(key=f"source:{sid}", value="ok", source=sid, synthetic=s.synthetic, observed_at=obs,
                    ttl_s=s.ttl_s, reliability=s.reliability, kind=s.kind)  # type: ignore[arg-type]

    def source_view(self, sid: str) -> FactView:
        s = self.sources[sid]
        note = None if s.enabled else ("outage (simulated)" if s.live else "unavailable (simulated)")
        return self.view(self.heartbeat(sid), key=f"source:{sid}", source=sid, synthetic=s.synthetic, note=note)

    def record_source_history(self) -> list[tuple[str, str, str]]:
        """Append a status sample per source; return status transitions (sid, old, new)."""
        changes = []
        t = self.now()
        for sid, s in self.sources.items():
            v = self.source_view(sid)
            s.history.append((t.isoformat(timespec="seconds"), v.status, v.confidence))
            if s.last_status is not None and s.last_status != v.status:
                changes.append((sid, s.last_status, v.status))
            s.last_status = v.status
        return changes

    def log_event(self, kind: str, message: str, severity: str = "info") -> dict:
        self.event_seq += 1
        e = {"seq": self.event_seq, "t": self.now().isoformat(timespec="seconds"), "kind": kind,
             "message": message, "severity": severity}
        self.events.append(e)
        return e

    def events_since(self, seq: int) -> list[dict]:
        return [e for e in self.events if e["seq"] > seq]

    def next_id(self, prefix: str) -> str:
        if prefix == "inc":
            self._incident_seq += 1
            return f"inc{self._incident_seq}"
        self._closure_seq += 1
        return f"cl{self._closure_seq}"

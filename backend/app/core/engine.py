"""Engine: one object that owns static data, live state, feeds, caches and the
re-planner. The API uses one live Engine; scenario replay builds throwaway
Engines (sharing the StaticWorld) on a ManualClock."""
from __future__ import annotations

from typing import Optional

import numpy as np

from ..config import data_dir, get_config
from .clock import SimClock, night_time
from .facts import STATUS_RANK
from .freshness import status_shares
from .replanner import Replanner
from .services import OpenCache, hours_coverage
from .sim.feeds import FeedSimulator
from .state import CREDITS, WorldState
from .world import CODE, StaticWorld


class Engine:
    def __init__(self, cfg: Optional[dict] = None, static: Optional[StaticWorld] = None, clock=None,
                 live: bool = True, warmup: bool = True, seed: Optional[int] = None):
        self.cfg = cfg or get_config()
        self.static = static or StaticWorld(self.cfg, data_dir())
        self.live = live
        self.reset(clock=clock, warmup=warmup, seed=seed)

    def reset(self, clock=None, warmup: bool = True, seed: Optional[int] = None) -> None:
        sim = self.cfg["sim"]
        start = night_time(sim["start_time"], self.static.night, self.static.tz)
        self.autostart = clock is None and bool(sim.get("start_paused", False))
        self.clock = clock or SimClock(start, speed=sim["speed"], paused=self.autostart)
        self.state = WorldState(self.static, self.clock, seed=seed)
        self.feeds = FeedSimulator(self.state, bursts=self.live)
        self.cache = OpenCache()
        self.replanner = Replanner(self)
        if warmup:
            self.feeds.warmup(sim.get("warmup_s", 300))
        self._last = self.clock.now()
        self.state.record_source_history()
        self.state.log_event("info", f"Simulation started at {start.strftime('%H:%M')} "
                                     f"({self.static.cfg['city_name']})")

    # ---- time -------------------------------------------------------------------------------
    def _step(self, dt: float) -> None:
        self.feeds.tick(dt)
        for sid, old, new in self.state.record_source_history():
            src = self.state.sources[sid]
            v = self.state.source_view(sid)
            up = STATUS_RANK[new] > STATUS_RANK[old]
            sev = "info" if up else ("alert" if new in ("OUTDATED", "UNKNOWN") else "warn")
            why = ""
            if src.live and not up and v.age_s is not None:
                why = f" (no update for {v.age_s / 60:.0f} min)"
            elif not src.enabled:
                why = " (source unavailable)"
            self.state.log_event("source", f"{src.label}: {old} -> {new}{why}", sev)

    def tick(self) -> bool:
        """Called by the live loop: catch up with the sim clock, then re-plan."""
        with self.state.lock:
            now = self.clock.now()
            dt = (now - self._last).total_seconds()
            if dt <= 0.5:
                return False
            self._last = now
            self._step(dt)
            self.replanner.tick_all()
            self.state.version += 1
            return True

    def advance(self, seconds: float, step: float = 30.0, replan_every_step: bool = False) -> None:
        """Fast-forward: move the clock in steps so feeds and fact ages evolve realistically."""
        with self.state.lock:
            n = max(1, int(np.ceil(seconds / step)))
            for _ in range(n):
                self.clock.advance(seconds / n)
                self._step(seconds / n)
                if replan_every_step:
                    self.replanner.tick_all()
            self._last = self.clock.now()
            if not replan_every_step:
                self.replanner.tick_all()
            self.state.version += 1

    # ---- trust board ------------------------------------------------------------------------------
    def trust(self) -> dict:
        s = self.state
        out = []
        for sid, src in s.sources.items():
            v = s.source_view(sid)
            out.append({"id": sid, "label": src.label, "kind": src.kind, "live": src.live,
                        "synthetic": src.synthetic, "enabled": src.enabled, "status": v.status,
                        "confidence": v.confidence, "age_s": v.age_s, "reliability": src.reliability,
                        "ttl_s": src.ttl_s, "note": v.note, "credit": CREDITS.get(sid),
                        "can_toggle": sid != "osm_map",
                        "history": [{"t": t, "status": st, "confidence": c} for t, st, c in list(src.history)[-30:]]})
        counts = {"KNOWN": 0, "PROBABLE": 0, "OUTDATED": 0, "UNKNOWN": 0}
        for f in s.store.values():
            counts[s.status_of(f)] += 1
        return {"now": s.now().isoformat(timespec="seconds"), "sources": out, "fact_counts": counts,
                "hours_coverage": hours_coverage(s, s.now()), "lighting_coverage": self.lighting_coverage(),
                "events": list(s.events)[-40:]}

    def lighting_coverage(self) -> dict:
        st = self.static
        S, L = st.walk_static, st.walk.elen
        w = {name: float(L[S.light_code == code].sum()) for name, code in CODE.items()}
        return {"shares": status_shares(w), "km": round(float(L.sum()) / 1000, 1),
                "note": "KNOWN = OSM lit tag or street lamps; PROBABLE = main-road prior; UNKNOWN = no data"}

    def sim_state(self) -> dict:
        s, tr = self.state, self.state.truth
        return {"now": s.now().isoformat(timespec="seconds"), "speed": self.clock.speed, "paused": self.clock.paused,
                "night": self.static.night.isoformat(),
                "sources": {sid: src.enabled for sid, src in s.sources.items()},
                "truth": {"rain": tr.rain, "fog": tr.fog, "closures": [{"id": k, "name": v["name"], "kind": v["kind"],
                                                                         "lat": v["lat"], "lon": v["lon"]}
                                                                        for k, v in tr.closures.items()],
                          "cancelled_routes": list(tr.cancel_route_from), "cancelled_trips": sorted(tr.cancelled_trips),
                          "schedule_conflicts": list(tr.schedule_conflicts), "cab_multiplier": tr.cab_multiplier,
                          "live_incidents": len(tr.incidents)},
                "active_plans": len(self.replanner.plans), "events": list(s.events)[-25:]}

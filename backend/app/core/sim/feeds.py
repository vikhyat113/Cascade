"""Live feed simulator: turns the simulator's ground truth into Facts.

Each live source emits readings with a random delay (observed_at < now), random
per-tick dropouts, partial coverage, and (optionally) short outage bursts, so
the freshness engine has real work to do. A disabled source simply stops
emitting: its facts age KNOWN -> PROBABLE -> OUTDATED -> UNKNOWN.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import numpy as np

from ...adapters.traffic_sim import true_speed_factor
from ...adapters.weather import RAIN_MM
from ..cab import prior_wait_min
from ..facts import Fact
from ..state import SourceState, WorldState


class FeedSimulator:
    def __init__(self, state: WorldState, bursts: bool = True):
        self.state = state
        self.bursts = bursts

    # ---- main tick --------------------------------------------------------------
    def tick(self, dt_s: float) -> None:
        s = self.state
        now = s.now()
        self._evolve_truth(now, dt_s)
        for sid, src in s.sources.items():
            if not src.live or not src.enabled:
                continue
            if src.burst_until and now < src.burst_until:
                continue
            if s.rng.random() < src.dropout:
                continue
            if self.bursts and s.rng.random() < 0.003:
                src.burst_until = now + timedelta(seconds=float(s.rng.uniform(60, 200)))
                continue
            obs = now - timedelta(seconds=float(s.rng.uniform(0, src.max_delay_s)))
            getattr(self, f"_emit_{sid}")(src, obs, now)
            src.last_ok = obs if src.last_ok is None else max(src.last_ok, obs)
            src.emitted += 1

    def warmup(self, seconds: float, step: float = 20.0) -> None:
        """Run feeds before the first plan so live facts exist (clock moves back after)."""
        s = self.state
        start = s.now()
        s.clock.set(start - timedelta(seconds=seconds))
        t = 0.0
        while t < seconds:
            s.clock.advance(step)
            self.tick(step)
            t += step
        s.clock.set(start)

    def _fact(self, src: SourceState, key: str, value, obs: datetime, note: str | None = None) -> Fact:
        return Fact(key=key, value=value, source=src.id, synthetic=src.synthetic, observed_at=obs,
                    ttl_s=src.ttl_s, reliability=src.reliability, kind="observed", note=note)  # type: ignore[arg-type]

    # ---- ground truth evolution -------------------------------------------------------
    def _evolve_truth(self, now: datetime, dt_s: float) -> None:
        s, tr, st = self.state, self.state.truth, self.state.static
        if st.transit:
            for trip in self._active_trips(now):
                d = tr.trip_delay.get(trip.id)
                if d is None:
                    d = float(np.clip(s.rng.normal(40, 60), -60, 300))
                d += float(s.rng.normal(0, 6)) * np.sqrt(max(dt_s, 1) / 60)
                tr.trip_delay[trip.id] = float(np.clip(d, -60, 900))
        # random live incident reports, weighted towards historically risky cells
        rate_per_h = 2.0 * (1.2 if now.hour in (0, 1, 2, 3) else 0.8)
        if s.rng.random() < rate_per_h * dt_s / 3600:
            risk = st.incidents.at(np.arange(st.grid.ncells), now.hour)
            p = risk / risk.sum() if risk.sum() > 0 else None
            cell = int(s.rng.choice(st.grid.ncells, p=p))
            cx, cy = st.grid.center(cell)
            lat, lon = st.proj.latlon(cx + s.rng.uniform(-100, 100), cy + s.rng.uniform(-100, 100))
            tr.incidents.append({"id": s.next_id("inc"), "lat": float(lat), "lon": float(lon), "t": now,
                                 "type": str(s.rng.choice(["harassment", "theft", "altercation"])),
                                 "severity": float(s.rng.uniform(0.3, 0.8))})
        tr.incidents = [i for i in tr.incidents if (now - i["t"]).total_seconds() < 3600]
        # heavy rain causes waterlogging at flood-prone spots after ~10 minutes
        if tr.rain in ("moderate", "heavy"):
            since = getattr(tr, "rain_since", None) or now
            if (now - since).total_seconds() >= 600 and "flood" not in tr.closures:
                tr.closures["flood"] = {"name": "Waterlogged streets", "reason": "waterlogging after heavy rain",
                                        "kind": "waterlogging", "walk_edges": [int(e) for e in st.flood_walk],
                                        "drive_edges": [int(e) for e in st.flood_drive],
                                        "lat": float(st.walk.emlat[st.flood_walk[0]]) if len(st.flood_walk) else None,
                                        "lon": float(st.walk.emlon[st.flood_walk[0]]) if len(st.flood_walk) else None,
                                        "since": now}
        elif "flood" in tr.closures:
            tr.lifted["flood"] = (now, tr.closures.pop("flood"))

    def _active_trips(self, now: datetime):
        st = self.state.static
        if not st.transit:
            return []
        lo, hi = now - timedelta(minutes=45), now + timedelta(minutes=60)
        return [t for t in st.transit.trips.values() if lo <= t.start <= hi]

    # ---- emitters (one per live source) --------------------------------------------------
    def _emit_traffic_live(self, src, obs, now):
        s, st, tr = self.state, self.state.static, self.state.truth
        for c in st.traffic_cells:
            if s.rng.random() > src.coverage:
                continue
            f = true_speed_factor(now.hour, float(st.traffic_bias[c]), tr.accidents.get(int(c), 1.0), tr.rain)
            f *= 1 + float(s.rng.normal(0, 0.03))
            s.put(self._fact(src, f"traffic:cell:{int(c)}", {"speed_factor": round(max(0.1, f), 3)}, obs))

    def _emit_transit_realtime(self, src, obs, now):
        s, tr = self.state, self.state.truth
        for trip in self._active_trips(now):
            if s.rng.random() > src.coverage:
                continue
            cancel_from = tr.cancel_route_from.get(trip.route_id)
            cancelled = trip.id in tr.cancelled_trips or (cancel_from is not None and trip.start >= cancel_from)
            delay = tr.trip_delay.get(trip.id, 0.0) + tr.schedule_conflicts.get(trip.route_id, 0.0)
            s.put(self._fact(src, f"transit:rt:{trip.id}",
                             {"delay_s": int(round(delay)), "cancelled": bool(cancelled), "route": trip.route_id}, obs))

    def _emit_weather_live(self, src, obs, now):
        s, st, tr = self.state, self.state.static, self.state.truth
        row = st.weather.at(now) or {}
        rc = tr.rain
        mm = RAIN_MM[rc] if rc else (row.get("rain_mm") or row.get("precip_mm") or 0.0)
        val = {"rain_mm": round(float(mm), 2), "rain_class": rc,
               "precip_prob": 100 if rc and rc != "none" else row.get("precip_prob"),
               "temp_c": row.get("temp_c"), "wind_kmh": row.get("wind_kmh"),
               "visibility_m": 600 if tr.fog else row.get("visibility_m"), "fog": tr.fog}
        s.put(self._fact(src, "weather:now", val, obs, note="simulated observation around the real forecast"))

    def _emit_closures_feed(self, src, obs, now):
        s, tr = self.state, self.state.truth
        for cid, c in tr.closures.items():
            s.put(self._fact(src, f"closure:{cid}", {"active": True, **{k: v for k, v in c.items() if k != "since"}},
                             obs))
        for cid, (t_lift, c) in list(tr.lifted.items()):
            s.put(self._fact(src, f"closure:{cid}", {"active": False, "name": c.get("name"), "reason": "lifted"}, obs))
            if (now - t_lift).total_seconds() > 1800:
                tr.lifted.pop(cid, None)

    def _emit_cab_availability(self, src, obs, now):
        s, st, tr = self.state, self.state.static, self.state.truth
        surge = 1.6 if tr.rain in ("moderate", "heavy") else 1.0
        for z in st.cab_zones:
            if s.rng.random() > 0.9:
                continue
            w = prior_wait_min(st, int(z), now.hour) * tr.cab_multiplier * surge * float(s.rng.lognormal(0, 0.15))
            s.put(self._fact(src, f"cab:zone:{int(z)}", {"wait_min": round(w, 1),
                                                          "drivers_nearby": int(max(0, 12 / max(w, 1)))}, obs))

    def _emit_incident_reports(self, src, obs, now):
        s = self.state
        for inc in s.truth.incidents:
            s.put(self._fact(src, f"incident:live:{inc['id']}",
                             {"lat": inc["lat"], "lon": inc["lon"], "type": inc["type"],
                              "severity": round(inc["severity"], 2), "reported_at": inc["t"].isoformat()}, obs,
                             note="unverified crowd report (simulated)"))

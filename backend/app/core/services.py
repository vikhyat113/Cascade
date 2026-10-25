"""Opening-hours facts for POIs, and the isolation / emergency-proximity layers
derived from "what is open around here at time t".

Open-state provenance:
  OSM opening_hours tag     -> observed fact, aged by the element's last edit
                               (<=1 y KNOWN, <=3 y PROBABLE, older OUTDATED)
  category prior            -> inferred fact, PROBABLE (e.g. police stations 24/7)
  nothing usable            -> value None -> UNKNOWN (never guessed)

Uncertainty propagates: the optimistic bound counts places whose hours are
UNKNOWN as possibly open, the pessimistic bound counts only KNOWN/PROBABLE-open.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

import numpy as np
from scipy.spatial import cKDTree

from ..adapters.osm import RoadGraph
from ..adapters.overpass import POI
from . import hours
from .facts import Fact, FactView
from .world import ACTIVITY_CATS, CODE, EMERGENCY_CATS

SPECIALIST_WORDS = ("eye", "dental", "skin", "clinic", "maternity", "diagnostic", "dispensary", "paediatric",
                    "glaucoma", "physio", "ivf")
HAVEN_CATS = {"hospital", "police", "fuel", "food", "shop", "pharmacy", "fire_station"}
YEAR_S = 365 * 86400


def _is_night(t: datetime) -> bool:
    return t.hour >= 21 or t.hour < 7


def category_prior(poi: POI, t: datetime) -> Optional[tuple[bool, float, str]]:
    name = (poi.name or "").lower()
    if poi.cat == "hospital":
        if any(w in name for w in SPECIALIST_WORDS):
            return (False, 0.5, "specialist centre: usually closed at night (inferred)") if _is_night(t) else None
        if poi.tags.get("emergency") == "yes":
            return True, 0.75, "hospital with emergency department (OSM emergency=yes): usually 24/7"
        return True, 0.55, "general hospital: usually admits 24/7 (inferred, not confirmed)"
    if poi.cat == "police":
        return True, 0.7, "police posts are staffed 24/7 (inferred)"
    if poi.cat == "fire_station":
        return True, 0.7, "fire stations are staffed 24/7 (inferred)"
    if poi.cat == "atm":
        return True, 0.5, "ATMs are usually 24/7 but may be shuttered (inferred)"
    if poi.cat in ("clinic", "bank"):
        return (False, 0.6, f"{poi.cat}s are usually closed at night (inferred)") if _is_night(t) else None
    return None   # pharmacy, food, shop, fuel, toilets: no reliable prior -> UNKNOWN


def open_fact(state, poi: POI, t: datetime) -> Fact:
    st = state.static
    key = f"poi:open:{poi.id}"
    raw = poi.tags.get("opening_hours")
    src = st.source_cfg["osm_hours"]
    if raw and state.available("osm_hours"):
        oh = hours.parse(raw)
        if oh is None:
            return Fact(key=key, value=None, source="osm_hours", synthetic=False, observed_at=poi.edited_at,
                        ttl_s=src["ttl_s"], reliability=src["reliability"], kind="observed",
                        note=f"opening_hours '{raw}' could not be parsed")
        edited = poi.edited_at.date().isoformat() if poi.edited_at else "unknown date"
        return Fact(key=key, value=oh.is_open(t), source="osm_hours", synthetic=False,
                    observed_at=poi.edited_at or st.pois_generated_at, ttl_s=src["ttl_s"],
                    reliability=src["reliability"], kind="observed",
                    note=f"OSM opening_hours \"{raw}\" (last edited {edited})")
    prior = category_prior(poi, t)
    if prior:
        val, rel, note = prior
        return Fact(key=key, value=val, source="prior", synthetic=False, observed_at=st.pois_generated_at,
                    ttl_s=YEAR_S, reliability=rel, kind="inferred", note=note)
    why = "opening hours unavailable (source outage)" if raw else "no opening hours in OSM and no reliable prior"
    return Fact(key=key, value=None, source="osm_hours", synthetic=False, observed_at=st.pois_generated_at,
                ttl_s=src["ttl_s"], reliability=src["reliability"], kind="observed", note=why)


def poi_view(state, poi: POI, t: datetime, dist_m: Optional[float] = None) -> dict:
    f = open_fact(state, poi, t)
    v = state.view(f)
    return {"id": poi.id, "name": poi.label, "cat": poi.cat, "lat": poi.lat, "lon": poi.lon,
            "open": v.model_dump(), "dist_m": round(dist_m) if dist_m is not None else None}


class OpenLayer:
    """Open-state of every facility at one time bucket + KD-trees for queries."""

    def __init__(self, state, t: datetime):
        self.t = t
        st = state.static
        self.items: list[tuple[POI, Fact, str, float]] = []
        for p in st.facilities:
            f = open_fact(state, p, t)
            self.items.append((p, f, state.status_of(f), state.conf_of(f)))

        def tree(pred):
            sel = [i for i, (p, f, s, c) in enumerate(self.items) if pred(p, f, s)]
            if not sel:
                return None, []
            return cKDTree(np.array([[self.items[i][0].x, self.items[i][0].y] for i in sel])), sel

        good = lambda f, s: f.value is True and s in ("KNOWN", "PROBABLE")          # noqa: E731
        maybe = lambda f, s: (f.value is True and s != "UNKNOWN") or s == "UNKNOWN"  # noqa: E731
        self.act_pess = tree(lambda p, f, s: p.cat in ACTIVITY_CATS and good(f, s))
        self.act_opt = tree(lambda p, f, s: p.cat in ACTIVITY_CATS and maybe(f, s))
        self.act_known = tree(lambda p, f, s: p.cat in ACTIVITY_CATS and f.value is True and s == "KNOWN")
        self.act_any = tree(lambda p, f, s: p.cat in ACTIVITY_CATS)
        self.em_pess = tree(lambda p, f, s: p.cat in EMERGENCY_CATS and good(f, s))
        self.em_opt = tree(lambda p, f, s: p.cat in EMERGENCY_CATS and maybe(f, s))
        self.haven = tree(lambda p, f, s: p.cat in HAVEN_CATS and good(f, s))

    @staticmethod
    def dist(tr, xy: np.ndarray, default: float = 1e5) -> tuple[np.ndarray, np.ndarray]:
        t, sel = tr
        if t is None:
            return np.full(len(xy), default), np.full(len(xy), -1)
        d, i = t.query(xy)
        return d, np.asarray(sel)[i]

    def within(self, tr, x: float, y: float, r: float) -> list[tuple[int, float]]:
        t, sel = tr
        if t is None:
            return []
        out = []
        for i in t.query_ball_point([x, y], r):
            p = self.items[sel[i]][0]
            out.append((sel[i], float(np.hypot(p.x - x, p.y - y))))
        return sorted(out, key=lambda z: z[1])


class EdgeOpenLayers:
    """Isolation + emergency intervals and status codes for every edge of a graph."""

    def __init__(self, layer: OpenLayer, G: RoadGraph, iso_base: np.ndarray):
        xy = np.c_[G.emx, G.emy]
        f = lambda d: np.clip((d - 60.0) / 700.0, 0.0, 1.0)  # noqa: E731
        d_opt, _ = layer.dist(layer.act_opt, xy)
        d_pess, _ = layer.dist(layer.act_pess, xy)
        d_known, _ = layer.dist(layer.act_known, xy)
        d_any, _ = layer.dist(layer.act_any, xy)
        self.iso_lo = 0.55 * iso_base + 0.45 * f(d_opt)
        self.iso_hi = 0.55 * iso_base + 0.45 * f(d_pess)
        code = np.full(G.m, CODE["UNKNOWN"], dtype=np.int8)
        code[d_any > 300] = CODE["PROBABLE"]          # nothing mapped nearby: isolated (inferred)
        code[d_pess <= 300] = CODE["PROBABLE"]
        code[d_known <= 300] = CODE["KNOWN"]
        self.iso_code = code
        e_opt, _ = layer.dist(layer.em_opt, xy)
        e_pess, self.em_idx = layer.dist(layer.em_pess, xy)
        self.em_lo = np.clip(e_opt / 3000.0, 0, 1)
        self.em_hi = np.clip(e_pess / 3000.0, 0, 1)
        self.em_dist = e_pess
        ecode = np.full(G.m, CODE["UNKNOWN"], dtype=np.int8)
        for i in np.unique(self.em_idx[self.em_idx >= 0]):
            ecode[self.em_idx == i] = CODE[layer.items[i][2]]
        ecode[e_pess > 3000] = CODE["UNKNOWN"]
        self.em_code = ecode


class OpenCache:
    """Caches OpenLayer / EdgeOpenLayers per 15-minute bucket and hours availability."""

    def __init__(self):
        self._layers: dict = {}
        self._edges: dict = {}

    def layer(self, state, t: datetime) -> OpenLayer:
        b = t.replace(minute=(t.minute // 15) * 15, second=0, microsecond=0)
        key = (b, state.available("osm_hours"), state.now().date())
        if key not in self._layers:
            if len(self._layers) > 24:
                self._layers.clear()
                self._edges.clear()
            self._layers[key] = OpenLayer(state, b)
        return self._layers[key]

    def edges(self, state, t: datetime, which: str) -> EdgeOpenLayers:
        layer = self.layer(state, t)
        key = (id(layer), which)
        if key not in self._edges:
            st = state.static
            G, S = (st.walk, st.walk_static) if which == "walk" else (st.drive, st.drive_static)
            self._edges[key] = EdgeOpenLayers(layer, G, S.iso_base)
        return self._edges[key]


def safe_havens_near(state, cache: OpenCache, t: datetime, x: float, y: float, r: float,
                     limit: int = 3) -> list[dict]:
    layer = cache.layer(state, t)
    out = []
    for i, d in layer.within(layer.haven, x, y, r)[:limit]:
        p, f, s, c = layer.items[i]
        out.append({**poi_view(state, p, t, d), "why": _haven_reason(p)})
    return out


def _haven_reason(p: POI) -> str:
    return {"hospital": "hospital lobby, staffed all night", "police": "police post",
            "fuel": "fuel station with attendants", "food": "open eatery", "shop": "open shop",
            "pharmacy": "open pharmacy", "fire_station": "fire station"}.get(p.cat, "open place")


def hours_coverage(state, t: datetime) -> dict:
    """Share of facilities whose open-state is KNOWN / PROBABLE / OUTDATED / UNKNOWN right now."""
    counts = {"KNOWN": 0, "PROBABLE": 0, "OUTDATED": 0, "UNKNOWN": 0}
    for p in state.static.facilities:
        counts[state.status_of(open_fact(state, p, t))] += 1
    n = max(1, sum(counts.values()))
    return {"counts": counts, "shares": {k: round(v / n, 3) for k, v in counts.items()}, "total": n}


def fact_dict(v: FactView) -> dict:
    return v.model_dump()

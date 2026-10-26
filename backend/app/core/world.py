"""StaticWorld: everything loaded from the data/ cache once at startup.

Holds the street graphs, POIs, transit network, weather cache, incident model,
per-edge static features (lighting interval + status, road-class priors, grid
cells) and the offline gazetteer. Nothing here changes during a run; dynamic
state lives in state.WorldState.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

import numpy as np
from scipy.spatial import cKDTree

from ..adapters import incidents_sim
from ..adapters.geo import LocalProjection
from ..adapters.osm import MAIN_ROADS, MINOR_ROADS, RoadGraph, load_pack
from ..adapters.overpass import POI, load_pois
from ..adapters.weather import WeatherCache
from .clock import night_date_for
from .facts import Fact
from .freshness import FreshnessConfig, confidence, status
from .grid import Grid
from .transit import TransitNetwork, load_transit

CODE = {"UNKNOWN": 0, "OUTDATED": 1, "PROBABLE": 2, "KNOWN": 3}
STATUS_OF = {v: k for k, v in CODE.items()}

LIT_YES = {"yes", "24/7", "automatic", "sunset-sunrise", "interval", "dusk-dawn"}
LIT_NO = {"no", "disused"}

CLASS_ISO = {"trunk": 0.3, "trunk_link": 0.35, "primary": 0.15, "primary_link": 0.2, "secondary": 0.2,
             "secondary_link": 0.25, "tertiary": 0.3, "tertiary_link": 0.3, "residential": 0.45,
             "living_street": 0.4, "unclassified": 0.5, "service": 0.55, "footway": 0.6, "path": 0.7,
             "pedestrian": 0.3, "track": 0.8, "steps": 0.6, "cycleway": 0.6, "motorway": 0.6,
             "motorway_link": 0.6}
CLASS_TRAFFIC_WALK = {"motorway": 0.6, "motorway_link": 0.5, "trunk": 0.4, "trunk_link": 0.35, "primary": 0.3,
                      "primary_link": 0.25, "secondary": 0.2, "secondary_link": 0.2, "tertiary": 0.12,
                      "tertiary_link": 0.12, "footway": 0.0, "path": 0.0, "pedestrian": 0.0, "steps": 0.0}

ACTIVITY_CATS = {"hospital", "police", "fire_station", "fuel", "food", "shop", "pharmacy", "clinic", "atm"}
EMERGENCY_CATS = {"hospital", "police"}


class DataMissing(RuntimeError):
    pass


@dataclass
class Place:
    name: str
    lat: float
    lon: float
    kind: str          # area | poi | street | stop
    cat: str = ""
    norm: str = ""


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", s.lower()).strip()


def _ts(s) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


class EdgeStatic:
    """Per-edge static features for one graph."""

    def __init__(self, G: RoadGraph, lamp_tree: Optional[cKDTree], osm_fact: Fact, prior_fact: Fact,
                 now: datetime, fc: FreshnessConfig, grid: Grid, tgrid: Grid, cgrid: Grid,
                 viirs_tree: Optional[cKDTree] = None, viirs_percentiles: Optional[np.ndarray] = None,
                 use_viirs_prior: bool = False):
        m = G.m
        self.light_lo = np.zeros(m)
        self.light_hi = np.zeros(m)
        self.light_code = np.zeros(m, dtype=np.int8)
        self.light_conf = np.zeros(m)
        self.light_note = np.empty(m, dtype=object)
        osm_st, osm_c = status(osm_fact, now, fc), confidence(osm_fact, now, fc)
        pr_st, pr_c = status(prior_fact, now, fc), confidence(prior_fact, now, fc)
        lamps = np.zeros(m, dtype=int)
        if lamp_tree is not None:
            lamps = np.array([len(x) for x in lamp_tree.query_ball_point(np.c_[G.emx, G.emy], r=35.0)])
        use_viirs = bool(use_viirs_prior and viirs_tree is not None and viirs_percentiles is not None and len(viirs_percentiles) > 0)
        nn_indices = None
        if use_viirs:
            _, nn_indices = viirs_tree.query(np.c_[G.emx, G.emy])

        for e in range(m):
            lit = (G.elit[e] or "").lower() or None
            hw = G.ehw[e]
            if lit in LIT_YES or lamps[e] >= 1:
                self._set(e, 0.05, 0.2, osm_st, osm_c, "lit (OSM lit tag / street lamps)")
            elif lit in LIT_NO:
                self._set(e, 0.8, 1.0, osm_st, osm_c, "unlit (OSM lit=no)")
            elif lit == "limited":
                self._set(e, 0.35, 0.6, osm_st, osm_c, "partly lit (OSM lit=limited)")
            elif hw in MAIN_ROADS:
                self._set(e, 0.15, 0.6, pr_st, pr_c, "no lighting data; main-road prior")
            elif use_viirs and nn_indices is not None and not np.isnan(viirs_percentiles[nn_indices[e]]):
                pct = float(viirs_percentiles[nn_indices[e]])
                norm_p = pct / 100.0
                darkness = 1.0 - norm_p
                lo = max(0.0, darkness - 0.25)
                hi = min(1.0, darkness + 0.25)
                self._set(e, lo, hi, "PROBABLE", 0.45, f"no OSM lighting; VIIRS satellite radiance prior (pct {pct:.0f}%)")
            elif hw in MINOR_ROADS:
                self._set(e, 0.25, 0.9, "UNKNOWN", 0.0, "no lighting data")
            else:
                self._set(e, 0.35, 1.0, "UNKNOWN", 0.0, "no lighting data (path)")
        self.iso_base = np.array([CLASS_ISO.get(h, 0.45) for h in G.ehw])
        self.walk_traffic = np.array([CLASS_TRAFFIC_WALK.get(h, 0.05) for h in G.ehw])
        self.cell = grid.index(G.emx, G.emy)
        self.tcell = tgrid.index(G.emx, G.emy)
        self.czone = cgrid.index(G.emx, G.emy)

    def _set(self, e, lo, hi, st, conf, note):
        self.light_lo[e], self.light_hi[e] = lo, hi
        self.light_code[e], self.light_conf[e], self.light_note[e] = CODE[st], conf, note


class StaticWorld:
    def __init__(self, cfg: dict, data_path: Path):
        self.cfg = cfg
        self.data_path = data_path
        self.tz = ZoneInfo(cfg["timezone"])
        self.night = night_date_for(cfg, self.tz)
        if not cfg.get("area_polygon"):
            self.area = None
        else:
            poly_str = str(cfg["area_polygon"])
            backend_dir = Path(__file__).resolve().parents[2]
            root_dir = Path(__file__).resolve().parents[3]
            cand = [
                Path(poly_str),
                (backend_dir / poly_str).resolve(),
                (root_dir / poly_str).resolve(),
                root_dir / "data" / Path(poly_str).name,
                data_path / Path(poly_str).name,
                data_path / poly_str,
                (data_path.parent / poly_str).resolve(),
            ]
            self.area = None
            for p in cand:
                if p.exists() and p.is_file():
                    from ..adapters.area import load_area
                    self.area = load_area(p, buffer_m=cfg.get("area_buffer_m", 300))
                    break
            if self.area is None:
                raise FileNotFoundError(
                    f"Configured area_polygon '{cfg.get('area_polygon')}' was not found. "
                    "Silent fallback to circle is not permitted when area_polygon is configured."
                )
        if self.area is not None:
            self.center = (float(self.area.centroid["lat"]), float(self.area.centroid["lon"]))
            self.radius = float(round(self.area.max_distance_to_vertex(), 1))
        else:
            self.center = (float(cfg["center"]["lat"]), float(cfg["center"]["lon"]))
            self.radius = float(cfg["radius_m"])
        self.proj = LocalProjection(*self.center)
        self.fc = FreshnessConfig.from_config(cfg)
        self.seed = int(cfg.get("seed", 42))
        self.source_cfg: dict = cfg["sources"]
        self.risk_cfg: dict = cfg["risk"]
        self.planner_cfg: dict = cfg["planner"]
        self.routing_cfg: dict = cfg.get("routing", {})
        load_now = datetime.now(timezone.utc)

        walk_p, drive_p = data_path / "graph_walk.json.gz", data_path / "graph_drive.json.gz"
        if not walk_p.exists() or not drive_p.exists():
            raise DataMissing("street graphs missing: run `python scripts/fetch_all.py` first")
        self.walk = RoadGraph(load_pack(walk_p), self.proj, "walk")
        self.drive = RoadGraph(load_pack(drive_p), self.proj, "drive")
        self.map_generated_at = _ts(self.walk.generated_at) or load_now

        self.pois, self.pois_generated_at = load_pois(data_path / "pois.json", self.proj)
        self.pois_generated_at = self.pois_generated_at or self.map_generated_at
        self.poi_by_id = {p.id: p for p in self.pois}
        lamps = [p for p in self.pois if p.cat == "street_lamp"]
        self.lamp_xy = np.array([[p.x, p.y] for p in lamps]) if lamps else np.zeros((0, 2))
        lamp_tree = cKDTree(self.lamp_xy) if len(lamps) else None
        self.facilities = [p for p in self.pois if p.cat in ACTIVITY_CATS | {"bank", "toilets", "fire_station"}]
        self.industrial = [p for p in self.pois if p.cat == "industrial"]

        self.transit: Optional[TransitNetwork] = load_transit(data_path / "transit_schedule.json",
                                                              self.night, self.tz, self.proj)
        self.weather = WeatherCache(data_path / "weather_cache.json", self.tz)

        if self.area is not None:
            coords = list(self.area.polygon.exterior.coords)
            xs, ys = self.proj.xy([c[1] for c in coords], [c[0] for c in coords])
            max_extent = max(float(np.max(np.abs(xs))), float(np.max(np.abs(ys))))
            half = max_extent + 600.0
        else:
            half = self.radius + 600.0
        self.grid = Grid(half, self.risk_cfg.get("grid_m", 250))
        self.tgrid = Grid(half, self.risk_cfg.get("traffic_cell_m", 500))
        self.cgrid = Grid(half, self.risk_cfg.get("cab_zone_m", 1000))

        # Polygon-clipped data layers
        def _read_data_json(name: str) -> Optional[dict]:
            p = data_path / name
            if not p.exists():
                return None
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                return None

        self.viirs_data = _read_data_json("viirs_ntl.json")
        self.viirs_observed_at = _ts(self.viirs_data.get("retrieved_at")) if self.viirs_data else None

        self.thermal_data = _read_data_json("thermal_lst.json")
        self.thermal_observed_at = _ts(self.thermal_data.get("acquisition_time") or self.thermal_data.get("retrieved_at")) if self.thermal_data else None

        self.weather_grid_data = _read_data_json("weather_grid.json")
        self.weather_grid_observed_at = _ts(self.weather_grid_data.get("retrieved_at")) if self.weather_grid_data else None

        self.live_weather = bool(cfg.get("live_weather", False))
        self.live_satellite = bool(cfg.get("live_satellite", False))
        self.live_weather_interval_min = int(cfg.get("live_weather_interval_min", 15))
        self.viirs_history_nights = int(cfg.get("viirs_history_nights", 14))

        from ..adapters.weather_live import WeatherLiveAdapter
        self.weather_live_adapter = WeatherLiveAdapter(
            data_path, self.tz, self.cfg.get("user_agent", "NightWay"),
            interval_min=self.live_weather_interval_min,
            live_enabled=self.live_weather,
        )
        if self.weather_live_adapter.grid_data:
            self.weather_grid_data = self.weather_live_adapter.grid_data
            if self.weather_live_adapter.last_fetch:
                self.weather_grid_observed_at = self.weather_live_adapter.last_fetch

        viirs_tree = None
        viirs_percentiles = None
        if self.viirs_data and "rows" in self.viirs_data:
            v_rows = [r for r in self.viirs_data["rows"] if r.get("lat") is not None and r.get("lon") is not None]
            if v_rows:
                v_lats = [r["lat"] for r in v_rows]
                v_lons = [r["lon"] for r in v_rows]
                v_xs, v_ys = self.proj.xy(v_lats, v_lons)
                viirs_tree = cKDTree(np.c_[v_xs, v_ys])
                viirs_percentiles = np.array([r.get("percentile", np.nan) for r in v_rows], dtype=float)
        self.viirs_tree = viirs_tree
        self.viirs_percentiles = viirs_percentiles
        self.use_viirs_prior = bool(cfg.get("use_viirs_lighting_prior", False))

        osm = self.source_cfg["osm_map"]
        osm_fact = Fact(key="osm_map", value="ok", source="osm_map", synthetic=False,
                        observed_at=self.map_generated_at, ttl_s=osm["ttl_s"], reliability=osm["reliability"],
                        kind="observed")
        prior_fact = Fact(key="prior:lighting", value="main roads usually lit", source="prior", synthetic=False,
                          observed_at=self.map_generated_at, ttl_s=osm["ttl_s"], reliability=0.5, kind="prior")
        self.walk_static = EdgeStatic(self.walk, lamp_tree, osm_fact, prior_fact, load_now, self.fc,
                                      self.grid, self.tgrid, self.cgrid,
                                      viirs_tree=self.viirs_tree, viirs_percentiles=self.viirs_percentiles,
                                      use_viirs_prior=self.use_viirs_prior)
        self.drive_static = EdgeStatic(self.drive, lamp_tree, osm_fact, prior_fact, load_now, self.fc,
                                       self.grid, self.tgrid, self.cgrid,
                                       viirs_tree=self.viirs_tree, viirs_percentiles=self.viirs_percentiles,
                                       use_viirs_prior=self.use_viirs_prior)
        rng = np.random.default_rng(self.seed)
        self.traffic_bias = rng.uniform(0.9, 1.05, self.tgrid.ncells)
        self.traffic_cells = np.unique(self.drive_static.tcell)
        self.cab_zones = np.unique(np.r_[self.walk_static.czone, self.drive_static.czone])
        self.zone_density = self._zone_density()
        self.flood_walk, self.flood_drive = self._flood_prone(rng)

        self.incident_path = data_path / "incidents_synthetic.csv"
        self.incidents = self._load_incidents()
        self.places = self._gazetteer()
        self.personas = self._personas()

    # ---- helpers -----------------------------------------------------------------
    def _zone_density(self) -> np.ndarray:
        """Facilities per cab zone, normalised: dense commercial areas get cabs faster."""
        d = np.zeros(self.cgrid.ncells)
        for p in self.facilities:
            d[self.cgrid.index(p.x, p.y)] += 1
        pos = d[d > 0]
        scale = float(np.percentile(pos, 75)) if pos.size else 1.0
        return d / max(1.0, scale)

    def _flood_prone(self, rng) -> tuple[np.ndarray, np.ndarray]:
        """Synthetic waterlogging-prone spots (a few low-lying clusters)."""
        G = self.walk
        cand = np.nonzero(np.isin(np.array(G.ehw), ["residential", "tertiary", "secondary", "unclassified"]))[0]
        seeds = rng.choice(cand, size=min(7, len(cand)), replace=False)
        pts = np.c_[G.emx[seeds], G.emy[seeds]]
        tw = cKDTree(np.c_[G.emx, G.emy])
        td = cKDTree(np.c_[self.drive.emx, self.drive.emy])
        fw = sorted({i for lst in tw.query_ball_point(pts, r=90) for i in lst})
        fd = sorted({i for lst in td.query_ball_point(pts, r=90) for i in lst})
        return np.array(fw, dtype=int), np.array(fd, dtype=int)

    def _load_incidents(self) -> incidents_sim.IncidentModel:
        if self.incident_path.exists():
            rows = incidents_sim.read_csv(self.incident_path)
        else:
            rows = incidents_sim.generate_history(self.grid, self.proj, self.cell_features(), self.seed)
            try:
                incidents_sim.write_csv(self.incident_path, rows)
            except OSError:
                pass
        self.incidents_generated_at = datetime.fromtimestamp(
            os.path.getmtime(self.incident_path), timezone.utc) if self.incident_path.exists() else self.map_generated_at
        return incidents_sim.IncidentModel(rows, self.grid, self.proj)

    def cell_features(self) -> dict[str, np.ndarray]:
        """Per-cell OSM proxies used to bias the synthetic incident generator."""
        G, S, n = self.walk, self.walk_static, self.grid.ncells
        road = np.bincount(S.cell, weights=G.elen, minlength=n)
        dark_w = G.elen * np.where(S.light_code == CODE["KNOWN"], S.light_lo, (S.light_lo + S.light_hi) / 2)
        dark = np.bincount(S.cell, weights=dark_w, minlength=n) / np.maximum(road, 1)
        cx, cy = self.grid.center(np.arange(n))
        act = [p for p in self.facilities if p.cat in ("hospital", "police", "fuel", "atm", "food")]
        if act:
            d, _ = cKDTree(np.array([[p.x, p.y] for p in act])).query(np.c_[cx, cy])
            iso = np.clip(d / 1200.0, 0, 1)
        else:
            iso = np.ones(n)
        ind = np.zeros(n)
        if self.industrial:
            d, _ = cKDTree(np.array([[p.x, p.y] for p in self.industrial])).query(np.c_[cx, cy])
            ind = np.clip(1 - d / 600.0, 0, 1)
        return {"road_m": road, "dark": dark, "iso": iso, "industrial": ind}

    def _gazetteer(self) -> list[Place]:
        out: list[Place] = []
        for p in self.pois:
            if not p.name or p.cat in ("street_lamp", "industrial"):
                continue
            kind = "area" if p.cat == "place" else ("stop" if p.cat in ("bus_stop", "metro_station") else "poi")
            out.append(Place(p.name, p.lat, p.lon, kind, p.cat))
        best: dict[str, tuple[float, int]] = {}
        for e, nm in enumerate(self.walk.ename):
            if nm and (nm not in best or self.walk.elen[e] > best[nm][0]):
                best[nm] = (float(self.walk.elen[e]), e)
        for nm, (_, e) in best.items():
            out.append(Place(nm, float(self.walk.emlat[e]), float(self.walk.emlon[e]), "street"))
        for pl in out:
            pl.norm = _norm(pl.name)
        return out

    def geocode(self, q: str, limit: int = 8) -> list[dict]:
        nq = _norm(q)
        if not nq:
            return []
        nums = set(re.findall(r"\d+", nq))
        scored = []
        for pl in self.places:
            if nums and not nums.issubset(set(re.findall(r"\d+", pl.norm))):
                continue          # "sector 12" must never silently become "sector 18"
            if pl.norm == nq:
                s = 3.0
            elif pl.norm.startswith(nq):
                s = 2.2
            elif nq in pl.norm:
                s = 1.8
            else:
                s = SequenceMatcher(None, nq, pl.norm).ratio()
                if s < 0.6:
                    continue
            s += {"area": 0.3, "stop": 0.15, "poi": 0.1, "street": 0.0}[pl.kind]
            scored.append((s, pl))
        scored.sort(key=lambda t: -t[0])
        seen, res = set(), []
        for s, pl in scored:
            k = (pl.name, round(pl.lat, 3), round(pl.lon, 3))
            if k in seen:
                continue
            seen.add(k)
            res.append({"name": pl.name, "lat": pl.lat, "lon": pl.lon, "kind": pl.kind, "cat": pl.cat,
                        "score": round(s, 2)})
            if len(res) >= limit:
                break
        return res

    def nearest_place_name(self, lat: float, lon: float, max_m: float = 400.0) -> Optional[str]:
        """Name of the closest named place / stop / street (for 'Near ...' after a map tap)."""
        if not hasattr(self, "_place_tree"):
            pts = [self.proj.xy(p.lat, p.lon) for p in self.places]
            self._place_tree = cKDTree(np.array([[float(x), float(y)] for x, y in pts])) if pts else None
        if self._place_tree is None:
            return None
        x, y = self.proj.xy(lat, lon)
        d, i = self._place_tree.query([float(x), float(y)])
        return self.places[int(i)].name if d <= max_m else None

    def _personas(self) -> list[dict]:
        out = []
        for p in self.cfg.get("personas", []):
            o = self.geocode(p["origin"], 1)
            h = self.geocode(p["home"], 1)
            c = {"lat": self.center[0], "lon": self.center[1]}
            out.append({**p,
                        "origin_point": {"lat": o[0]["lat"], "lon": o[0]["lon"], "name": o[0]["name"]} if o
                        else {**c, "name": "City centre"},
                        "home_point": {"lat": h[0]["lat"], "lon": h[0]["lon"],
                                       "name": p.get("home_label") or h[0]["name"]} if h
                        else {**c, "name": p.get("home_label", "Home")}})
        return out

    def in_area(self, lat: float, lon: float) -> bool:
        if self.area is not None:
            return self.area.contains_buffered(lat, lon)
        x, y = self.proj.xy(lat, lon)
        return float(np.hypot(x, y)) <= self.radius + 300


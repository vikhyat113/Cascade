"""Synthetic incident history (clearly synthetic) + the density model that reads it.

Generation is seeded and biased by real OSM proxies per grid cell: share of
unlit / unknown-lighting street length, isolation (distance to anything open at
night), and nearby industrial land. The output is a plain CSV
(lat, lon, hour, minute, night, type) so a real incident dataset can be dropped
in later with the same columns.
"""
from __future__ import annotations

import csv
from pathlib import Path
from typing import Optional

import numpy as np

from ..core.grid import Grid
from .geo import LocalProjection

HOUR_PROFILE = {18: 0.35, 19: 0.45, 20: 0.55, 21: 0.65, 22: 0.8, 23: 0.95, 0: 1.05, 1: 1.15,
                2: 1.2, 3: 1.1, 4: 0.85, 5: 0.6, 6: 0.4, 7: 0.3}
TYPES = ["theft", "harassment", "assault", "vehicle", "other"]
TYPE_P = [0.35, 0.3, 0.1, 0.15, 0.1]
TARGET_TOTAL = 3500


def generate_history(grid: Grid, proj: LocalProjection, features: dict[str, np.ndarray],
                     seed: int, nights: int = 90) -> list[dict]:
    rng = np.random.default_rng(seed)
    road_km = features["road_m"] / 1000.0
    prop = (0.15 + 0.35 * features["dark"] + 0.3 * features["iso"] + 0.2 * features["industrial"])
    prop = prop * rng.lognormal(0.0, 0.45, grid.ncells) * (road_km > 0)
    base = prop * road_km
    expected_total = base.sum() * nights * sum(HOUR_PROFILE.values())
    k = TARGET_TOTAL / expected_total if expected_total > 0 else 0.0
    rows = []
    for hour, prof in HOUR_PROFILE.items():
        lam = base * k * prof
        counts = rng.poisson(lam, size=(nights, grid.ncells))
        for night, cell in zip(*np.nonzero(counts)):
            for _ in range(counts[night, cell]):
                cx, cy = grid.center(cell)
                x = cx + rng.uniform(-0.5, 0.5) * grid.size
                y = cy + rng.uniform(-0.5, 0.5) * grid.size
                lat, lon = proj.latlon(x, y)
                rows.append({"night": int(night), "hour": hour, "minute": int(rng.integers(0, 60)),
                             "lat": round(float(lat), 6), "lon": round(float(lon), 6),
                             "type": str(rng.choice(TYPES, p=TYPE_P)), "synthetic": 1})
    return rows


def write_csv(path: Path, rows: list[dict]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["night", "hour", "minute", "lat", "lon", "type", "synthetic"])
        w.writeheader()
        w.writerows(rows)


def read_csv(path: Path) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            try:
                rows.append({"night": int(r.get("night", 0) or 0), "hour": int(r["hour"]),
                             "lat": float(r["lat"]), "lon": float(r["lon"]), "type": r.get("type", "other"),
                             "synthetic": int(r.get("synthetic", 1) or 0)})
            except (KeyError, ValueError):
                continue
    return rows


class IncidentModel:
    """Hour-aware incident risk per grid cell, in [0, 1]."""

    def __init__(self, rows: list[dict], grid: Grid, proj: LocalProjection, nights: Optional[int] = None):
        self.grid = grid
        self.n_rows = len(rows)
        self.synthetic = any(r.get("synthetic", 1) for r in rows) if rows else True
        nights = nights or (max((r["night"] for r in rows), default=0) + 1)
        self.nights = max(1, nights)
        counts = np.zeros((24, grid.ncells))
        if rows:
            lat = np.array([r["lat"] for r in rows])
            lon = np.array([r["lon"] for r in rows])
            hrs = np.array([r["hour"] % 24 for r in rows])
            x, y = proj.xy(lat, lon)
            idx = grid.index(x, y)
            np.add.at(counts, (hrs, idx), 1.0)
        dens = counts / self.nights
        spatial = np.stack([grid.neighbours_sum(dens[h], 1.0, 0.35) / 3.8 for h in range(24)])
        temporal = 0.5 * spatial + 0.25 * np.roll(spatial, 1, axis=0) + 0.25 * np.roll(spatial, -1, axis=0)
        nz = temporal[temporal > 0]
        scale = float(np.percentile(nz, 90)) if nz.size else 1.0
        self.risk = 1.0 - np.exp(-temporal / max(scale, 1e-9) * 1.2)
        self.counts = counts

    def at(self, cell_idx, hour: int) -> np.ndarray:
        return self.risk[hour % 24][np.asarray(cell_idx)]

    def recent_count(self, cell_idx: int, hour: int) -> float:
        return float(self.counts[hour % 24][cell_idx])

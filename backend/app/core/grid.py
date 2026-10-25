"""Square grid over the demo area (local metres). Used for incident density,
traffic cells, cab zones and the heatmap."""
from __future__ import annotations

import numpy as np


class Grid:
    def __init__(self, half_extent_m: float, size_m: float):
        self.size = float(size_m)
        self.xmin = self.ymin = -float(half_extent_m)
        self.nx = self.ny = int(np.ceil(2 * half_extent_m / size_m))
        self.ncells = self.nx * self.ny

    def index(self, x, y):
        i = np.clip(((np.asarray(x) - self.xmin) // self.size).astype(int), 0, self.nx - 1)
        j = np.clip(((np.asarray(y) - self.ymin) // self.size).astype(int), 0, self.ny - 1)
        return j * self.nx + i

    def center(self, idx):
        idx = np.asarray(idx)
        i, j = idx % self.nx, idx // self.nx
        return self.xmin + (i + 0.5) * self.size, self.ymin + (j + 0.5) * self.size

    def key(self, idx: int) -> str:
        return f"{idx % self.nx}_{idx // self.nx}"

    def neighbours_sum(self, values: np.ndarray, weight_center=1.0, weight_side=0.5) -> np.ndarray:
        """3x3 smoothing of a per-cell array."""
        a = values.reshape(self.ny, self.nx)
        p = np.pad(a, 1)
        out = weight_center * a
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                if di or dj:
                    out = out + weight_side * p[1 + dj:1 + dj + self.ny, 1 + di:1 + di + self.nx]
        return out.reshape(-1)

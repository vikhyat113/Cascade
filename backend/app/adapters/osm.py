"""Street graphs from the compact routing pack written by scripts/fetch_graph.py.

Routing uses scipy's C Dijkstra on a CSR matrix whose structure is built once;
each query only swaps the cost array, so a shortest path on the demo graph
takes a few milliseconds.
"""
from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Optional

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree

from .geo import LocalProjection

BLOCKED_COST = 1e12

MAIN_ROADS = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
              "secondary", "secondary_link", "tertiary", "tertiary_link"}
MINOR_ROADS = {"residential", "unclassified", "living_street", "service", "road"}
PATHS = {"footway", "path", "pedestrian", "track", "steps", "cycleway", "bridleway", "corridor"}


def load_pack(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)


class RoadGraph:
    def __init__(self, pack: dict, proj: LocalProjection, name: str = "graph"):
        self.name = name
        self.proj = proj
        self.directed = bool(pack["directed"])
        self.generated_at = pack.get("generated_at")
        N, E = pack["nodes"], pack["edges"]
        self.node_ids = np.asarray(N["id"], dtype=np.int64)
        self.lat = np.asarray(N["lat"], dtype=float)
        self.lon = np.asarray(N["lon"], dtype=float)
        self.x, self.y = proj.xy(self.lat, self.lon)
        self.n = len(self.node_ids)

        self.eu = np.asarray(E["u"], dtype=np.int64)
        self.ev = np.asarray(E["v"], dtype=np.int64)
        self.elen = np.maximum(np.asarray(E["len"], dtype=float), 0.5)
        self.ehw: list[str] = [h or "unclassified" for h in E["hw"]]
        self.elit: list[Optional[str]] = E["lit"]
        self.ename: list[Optional[str]] = E["name"]
        self.espeed = np.array([s if s is not None else np.nan for s in E["speed"]], dtype=float)
        self.egeom: list[list[list[float]]] = E["geom"]
        self.m = len(self.eu)
        self.is_main = np.array([h in MAIN_ROADS for h in self.ehw])

        mid = [g[len(g) // 2] if len(g) > 2 else [(g[0][0] + g[-1][0]) / 2, (g[0][1] + g[-1][1]) / 2]
               for g in self.egeom]
        self.emlon = np.array([p[0] for p in mid])
        self.emlat = np.array([p[1] for p in mid])
        self.emx, self.emy = proj.xy(self.emlat, self.emlon)

        self.node_tree = cKDTree(np.c_[self.x, self.y])
        self.edge_tree = cKDTree(np.c_[self.emx, self.emy])
        self._build_arcs()

    # ---- routing structure -------------------------------------------------
    def _build_arcs(self) -> None:
        if self.directed:
            au, av = self.eu, self.ev
            ae, arev = np.arange(self.m), np.zeros(self.m, dtype=bool)
        else:
            au, av = np.r_[self.eu, self.ev], np.r_[self.ev, self.eu]
            ae, arev = np.r_[np.arange(self.m), np.arange(self.m)], np.r_[np.zeros(self.m, bool), np.ones(self.m, bool)]
        keep = au != av                                  # drop self loops
        au, av, ae, arev = au[keep], av[keep], ae[keep], arev[keep]
        keys = au * self.n + av
        order = np.argsort(keys, kind="stable")
        self._arc_e, self._arc_rev, keys = ae[order], arev[order], keys[order]
        self._ukeys, self._starts = np.unique(keys, return_index=True)
        uu, vv = self._ukeys // self.n, self._ukeys % self.n
        counts = np.bincount(uu, minlength=self.n)
        self._indptr = np.r_[0, np.cumsum(counts)].astype(np.int32)
        self._indices = vv.astype(np.int32)
        self._adj = self._build_adj()

    def _build_adj(self) -> list[list[tuple[int, int, bool]]]:
        adj: list[list[tuple[int, int, bool]]] = [[] for _ in range(self.n)]
        if self.directed:
            for eid in range(self.m):
                adj[int(self.eu[eid])].append((int(self.ev[eid]), eid, False))
        else:
            for eid in range(self.m):
                u, v = int(self.eu[eid]), int(self.ev[eid])
                adj[u].append((v, eid, False))
                adj[v].append((u, eid, True))
        return adj

    def shortest_path(self, src: int, dst: int, edge_cost: np.ndarray,
                      blocked: Optional[np.ndarray] = None) -> Optional[list[tuple[int, bool]]]:
        """Return [(edge_index, reversed), ...] or None if unreachable."""
        if src == dst:
            return []
        c = np.maximum(edge_cost, 0.01).astype(float)
        if blocked is not None and blocked.any():
            c = np.where(blocked, BLOCKED_COST, c)
        arc_c = c[self._arc_e]
        gmin = np.minimum.reduceat(arc_c, self._starts)
        mat = csr_matrix((gmin, self._indices, self._indptr), shape=(self.n, self.n))
        dist, pred = dijkstra(mat, directed=True, indices=src, return_predecessors=True)
        if not np.isfinite(dist[dst]) or dist[dst] >= BLOCKED_COST:
            return None
        nodes = [dst]
        while nodes[-1] != src:
            p = pred[nodes[-1]]
            if p < 0:
                return None
            nodes.append(int(p))
        nodes.reverse()
        out = []
        for a, b in zip(nodes, nodes[1:]):
            gi = int(np.searchsorted(self._ukeys, a * self.n + b))
            s = self._starts[gi]
            e = self._starts[gi + 1] if gi + 1 < len(self._starts) else len(self._arc_e)
            best = s + int(np.argmin(arc_c[s:e]))
            out.append((int(self._arc_e[best]), bool(self._arc_rev[best])))
        return out

    # ---- spatial helpers -----------------------------------------------------
    def nearest_node(self, lat: float, lon: float) -> tuple[int, float]:
        x, y = self.proj.xy(lat, lon)
        d, i = self.node_tree.query([float(x), float(y)])
        return int(i), float(d)

    def path_coords(self, path: list[tuple[int, bool]]) -> list[list[float]]:
        coords: list[list[float]] = []
        for e, rev in path:
            g = self.egeom[e][::-1] if rev else self.egeom[e]
            coords.extend(g if not coords else g[1:])
        return coords

    def node_latlon(self, i: int) -> tuple[float, float]:
        return float(self.lat[i]), float(self.lon[i])

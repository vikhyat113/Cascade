"""Synthetic traffic ground truth (labelled synthetic everywhere).

speed = OSMnx free-flow speed (add_edge_speeds) x hour-of-night factor x a
persistent per-cell bias x accident / rain factors. Near free-flow at 01:00-03:00,
small slowdowns around the 22:00 and 06:00 shift changes.
"""
from __future__ import annotations

HOUR_SPEED = {18: 0.6, 19: 0.62, 20: 0.7, 21: 0.8, 22: 0.84, 23: 0.92, 0: 0.97, 1: 1.0, 2: 1.0,
              3: 1.0, 4: 0.97, 5: 0.9, 6: 0.8, 7: 0.7}
RAIN_SPEED = {None: 1.0, "none": 1.0, "light": 0.92, "moderate": 0.82, "heavy": 0.68}

# km/h used when OSM gives no speed for a road class
DEFAULT_KPH = {"motorway": 70, "trunk": 55, "primary": 45, "secondary": 40, "tertiary": 35,
               "residential": 25, "living_street": 15, "service": 15, "unclassified": 25}


def true_speed_factor(hour: int, cell_bias: float, accident: float = 1.0, rain: str | None = None) -> float:
    return max(0.1, HOUR_SPEED.get(hour % 24, 0.75) * cell_bias * accident * RAIN_SPEED.get(rain, 1.0))

"""Load the cached Overpass POI extract (data/pois.json, made by scripts/fetch_pois.py).
No network access here: the demo never calls Overpass live."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

from .geo import LocalProjection

CATEGORY_LABEL = {
    "hospital": "Hospital", "clinic": "Clinic", "pharmacy": "Pharmacy", "police": "Police",
    "fire_station": "Fire station", "fuel": "Fuel station", "atm": "ATM", "bank": "Bank",
    "food": "Food", "shop": "Shop", "bus_stop": "Bus stop", "metro_station": "Metro",
    "rail_station": "Railway station", "toilets": "Toilets", "street_lamp": "Street lamp",
    "place": "Place", "industrial": "Industrial area",
}


@dataclass
class POI:
    id: str
    cat: str
    lat: float
    lon: float
    name: Optional[str]
    tags: dict = field(default_factory=dict)
    edited_at: Optional[datetime] = None
    x: float = 0.0
    y: float = 0.0

    @property
    def label(self) -> str:
        return self.name or f"{CATEGORY_LABEL.get(self.cat, self.cat.title())} (unnamed)"


def _ts(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def load_pois(path: Path, proj: LocalProjection) -> tuple[list[POI], Optional[datetime]]:
    if not path.exists():
        return [], None
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for r in data.get("pois", []):
        try:
            p = POI(id=r["id"], cat=r["cat"], lat=float(r["lat"]), lon=float(r["lon"]), name=r.get("name"),
                    tags=r.get("tags") or {}, edited_at=_ts(r.get("edited_at")))
        except (KeyError, TypeError, ValueError):
            continue    # skip malformed rows rather than crash
        x, y = proj.xy(p.lat, p.lon)
        p.x, p.y = float(x), float(y)
        out.append(p)
    return out, _ts(data.get("generated_at"))

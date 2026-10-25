"""Cab / auto availability: a time-of-night x area-density prior, refined by the
(simulated) live availability feed. Always reported as a wait-time range."""
from __future__ import annotations

from datetime import datetime

from .facts import Fact


def prior_wait_min(static, zone: int, hour: int) -> float:
    base = float(static.cfg.get("cab", {}).get("base_wait_min", {}).get(str(hour % 24), 10))
    dens = float(static.zone_density[zone]) if zone < len(static.zone_density) else 0.0
    return base * (1.6 - 0.45 * min(dens, 2.0))


def prior_fact(static, zone: int, hour: int) -> Fact:
    return Fact(key=f"cab:prior:{zone}", value={"wait_min": round(prior_wait_min(static, zone, hour), 1)},
                source="prior", synthetic=True, observed_at=static.map_generated_at, ttl_s=365 * 86400,
                reliability=0.5, kind="prior", note="night-time availability model (hour x area density)")


def cab_wait(state, lat: float, lon: float, t: datetime) -> dict:
    st = state.static
    x, y = st.proj.xy(lat, lon)
    zone = int(st.cgrid.index(x, y))
    f = state.get(f"cab:zone:{zone}")
    s = state.status_of(f)
    if s in ("KNOWN", "PROBABLE"):
        w = float(f.value["wait_min"])
        lo, hi = 0.6 * w, 1.6 * w
        used = f
    elif s == "OUTDATED":
        w = float(f.value["wait_min"])
        lo, hi = 0.5 * w, 2.2 * w
        used = f
    else:
        used = prior_fact(st, zone, t.hour)
        w = used.value["wait_min"]
        lo, hi = 0.5 * w, 2.5 * w
    if 2 <= t.hour <= 4 and st.zone_density[zone] < 0.3:
        hi *= 1.3                      # sparse area in the dead of night
    view = state.view(used, interval=(round(lo, 1), round(hi, 1)))
    return {"lo": lo * 60, "exp": w * 60, "hi": hi * 60, "view": view, "zone": zone}

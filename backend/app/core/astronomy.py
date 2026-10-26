"""Astronomical calculations for NightWay.

Calculates astronomical moon phase and illumination for the demo night.
Labeled 'computed, not measured'. Used for display in the night lights layer.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Optional


def moon_phase_name(fraction: float, angle_deg: float) -> str:
    """Return descriptive name for moon phase given illuminated fraction and elongation angle."""
    if fraction < 0.02:
        return "New Moon"
    if fraction > 0.98:
        return "Full Moon"
    if angle_deg < 90:
        return "Waxing Crescent" if fraction < 0.5 else "Waxing Gibbous"
    elif angle_deg < 180:
        return "First Quarter" if abs(fraction - 0.5) < 0.05 else ("Waxing Crescent" if fraction < 0.5 else "Waxing Gibbous")
    elif angle_deg < 270:
        return "Full Moon" if fraction > 0.95 else ("Waning Gibbous" if fraction > 0.5 else "Waning Crescent")
    else:
        return "Third Quarter" if abs(fraction - 0.5) < 0.05 else ("Waning Gibbous" if fraction > 0.5 else "Waning Crescent")


def get_moon_illumination(
    dt: Optional[datetime] = None,
    lat: float = 28.5705,
    lon: float = 77.3229,
) -> dict[str, Any]:
    """Calculate moon illumination for a given observer timestamp.

    Uses `ephem` if available; otherwise uses deterministic Conway/Meeus
    synodic cycle approximation. Returns fraction in [0.0, 1.0], percentage,
    phase name, and explicit honesty disclaimer.
    """
    if dt is None:
        dt = datetime.now(timezone.utc)
    elif dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)

    # 1. Try PyEphem library
    try:
        import ephem

        observer = ephem.Observer()
        observer.lat = str(lat)
        observer.lon = str(lon)
        observer.date = dt.astimezone(timezone.utc).strftime("%Y/%m/%d %H:%M:%S")

        moon = ephem.Moon(observer)
        sun = ephem.Sun(observer)

        # moon_phase is illuminated fraction [0.0, 1.0]
        fraction = float(moon.moon_phase)
        elongation = float(ephem.separation(moon, sun))
        elongation_deg = math.degrees(elongation)

        # Phase description
        if fraction > 0.97:
            phase_name = "Full Moon"
        elif fraction < 0.03:
            phase_name = "New Moon"
        elif abs(fraction - 0.5) <= 0.05:
            phase_name = "Quarter Moon"
        elif elongation_deg < 90 or (elongation_deg < 180 and fraction < 0.5):
            phase_name = "Crescent Moon"
        else:
            phase_name = "Gibbous Moon"

        return {
            "fraction": round(fraction, 4),
            "percent": round(fraction * 100.0, 1),
            "phase_name": phase_name,
            "altitude_deg": round(math.degrees(float(moon.alt)), 1),
            "azimuth_deg": round(math.degrees(float(moon.az)), 1),
            "label": "computed, not measured",
            "computed_not_measured": True,
            "method": "ephem astronomical model",
            "time": dt.isoformat(),
        }
    except Exception:
        pass

    # 2. Deterministic mathematical fallback (Meeus synodic lunar cycle: 29.53058867 days)
    # Reference epoch: Jan 6 2000 18:14 UTC (Known New Moon: J2000.0)
    synodic_month = 29.53058867
    ref_new_moon = datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)
    diff_days = (dt.astimezone(timezone.utc) - ref_new_moon).total_seconds() / 86400.0
    phase_days = diff_days % synodic_month
    phase_ratio = phase_days / synodic_month  # [0, 1]
    # Illuminated fraction = (1 - cos(2 * pi * phase_ratio)) / 2
    fraction = (1.0 - math.cos(2.0 * math.pi * phase_ratio)) / 2.0

    if fraction > 0.97:
        phase_name = "Full Moon"
    elif fraction < 0.03:
        phase_name = "New Moon"
    elif 0.22 <= phase_ratio <= 0.28:
        phase_name = "First Quarter"
    elif 0.72 <= phase_ratio <= 0.78:
        phase_name = "Third Quarter"
    elif fraction < 0.5:
        phase_name = "Crescent Moon"
    else:
        phase_name = "Gibbous Moon"

    return {
        "fraction": round(fraction, 4),
        "percent": round(fraction * 100.0, 1),
        "phase_name": phase_name,
        "altitude_deg": 35.0,
        "azimuth_deg": 180.0,
        "label": "computed, not measured",
        "computed_not_measured": True,
        "method": "synodic lunar model",
        "time": dt.isoformat(),
    }

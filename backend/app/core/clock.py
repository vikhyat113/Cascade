"""Simulated clock + night-time parsing helpers.

The whole engine runs on `clock.now()` (an aware datetime in the city timezone),
never on the wall clock, so demos can fast-forward and scenarios replay
deterministically.
"""
from __future__ import annotations

import re
import time
from datetime import date, datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo


class SimClock:
    """now = anchor_sim + (real elapsed since anchor) * speed, unless paused."""

    def __init__(self, start: datetime, speed: float = 1.0, paused: bool = False):
        self._anchor_sim = start
        self._anchor_real = time.monotonic()
        self.speed = float(speed)
        self.paused = paused

    def now(self) -> datetime:
        if self.paused:
            return self._anchor_sim
        return self._anchor_sim + timedelta(seconds=(time.monotonic() - self._anchor_real) * self.speed)

    def _reanchor(self, sim: datetime) -> None:
        self._anchor_sim = sim
        self._anchor_real = time.monotonic()

    def set(self, time_: Optional[datetime] = None, speed: Optional[float] = None,
            paused: Optional[bool] = None) -> None:
        current = self.now()
        if speed is not None:
            self.speed = max(0.0, float(speed))
        if paused is not None:
            self.paused = paused
        self._reanchor(time_ or current)

    def advance(self, seconds: float) -> None:
        self._reanchor(self.now() + timedelta(seconds=seconds))


class ManualClock:
    """Deterministic clock for tests and scenario replay."""

    def __init__(self, start: datetime):
        self._now = start
        self.speed = 0.0
        self.paused = True

    def now(self) -> datetime:
        return self._now

    def set(self, time_: Optional[datetime] = None, speed=None, paused=None) -> None:
        if time_ is not None:
            self._now = time_

    def advance(self, seconds: float) -> None:
        self._now = self._now + timedelta(seconds=seconds)


_TIME_RE = re.compile(r"^\s*(\d{1,2})(?:[:.](\d{2}))?\s*([ap]\.?m\.?)?\s*$", re.I)


def night_date_for(cfg: dict, tz: ZoneInfo) -> date:
    """The calendar date the demo night *starts* on ("tonight")."""
    nd = cfg.get("sim", {}).get("night_date", "auto")
    if nd and nd != "auto":
        return date.fromisoformat(str(nd))
    now = datetime.now(tz)
    return now.date() if now.hour >= 12 else now.date() - timedelta(days=1)


def parse_hhmm(text: str) -> tuple[int, int]:
    m = _TIME_RE.match(str(text))
    if not m:
        raise ValueError(f"bad time: {text!r}")
    h, mi, ap = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").lower().replace(".", "")
    if ap == "pm" and h < 12:
        h += 12
    if ap == "am" and h == 12:
        h = 0
    if not (0 <= h <= 23 and 0 <= mi <= 59):
        raise ValueError(f"bad time: {text!r}")
    return h, mi


def night_time(text: str, night: date, tz: ZoneInfo) -> datetime:
    """Map "02:15" onto the demo night: 12:00-23:59 -> night date, 00:00-11:59 -> next day."""
    h, mi = parse_hhmm(text)
    d = night if h >= 12 else night + timedelta(days=1)
    return datetime(d.year, d.month, d.day, h, mi, tzinfo=tz)


def to_night(dt_or_text, night: date, tz: ZoneInfo) -> datetime:
    if isinstance(dt_or_text, datetime):
        return dt_or_text if dt_or_text.tzinfo else dt_or_text.replace(tzinfo=tz)
    s = str(dt_or_text)
    if "T" in s or len(s) > 8:
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=tz)
    return night_time(s, night, tz)


def hhmm(dt: Optional[datetime]) -> str:
    return dt.strftime("%H:%M") if dt else "--:--"

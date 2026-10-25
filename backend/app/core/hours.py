"""Small OSM `opening_hours` parser covering the common patterns.

Supported: "24/7", "Mo-Fr 08:30-17:30", "Mo-Su 06:00-14:00,16:00-21:00",
"Mo-Fr 08:30-05:00" (past midnight), "09:00-23:00", "Sa,Su off", "PH off"
(public holidays are ignored), several rules separated by ";" where a later
rule replaces the days it mentions (OSM semantics).

Anything else (sunrise, month ranges, open ends, comments) fails gracefully:
`parse()` returns None and callers must treat the hours as UNKNOWN.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]
_TIME = re.compile(r"^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$")
_DAYSPEC = re.compile(r"^(Mo|Tu|We|Th|Fr|Sa|Su)(-(Mo|Tu|We|Th|Fr|Sa|Su))?$")


@dataclass
class OpeningHours:
    raw: str
    always: bool = False
    # day index -> list of (start_min, end_min); end may exceed 1440 (past midnight)
    days: dict[int, list[tuple[int, int]]] = field(default_factory=dict)

    def is_open(self, t: datetime) -> bool:
        if self.always:
            return True
        m = t.hour * 60 + t.minute
        d = t.weekday()
        for s, e in self.days.get(d, []):
            if s <= m < e:
                return True
        prev = (d - 1) % 7
        for s, e in self.days.get(prev, []):
            if e > 1440 and m < e - 1440:
                return True
        return False

    def next_change(self, t: datetime, horizon_h: int = 30) -> Optional[datetime]:
        """When the open/closed state next flips (minute resolution, bounded search)."""
        if self.always:
            return None
        state = self.is_open(t)
        step = t.replace(second=0, microsecond=0)
        for _ in range(horizon_h * 4):
            step += timedelta(minutes=15)
            if self.is_open(step) != state:
                # refine to the minute
                back = step - timedelta(minutes=15)
                for _ in range(15):
                    back += timedelta(minutes=1)
                    if self.is_open(back) != state:
                        return back
                return step
        return None


def _parse_days(spec: str) -> Optional[set[int]]:
    out: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        m = _DAYSPEC.match(part)
        if not m:
            return None
        a = DAYS.index(m.group(1))
        b = DAYS.index(m.group(3)) if m.group(3) else a
        i = a
        while True:
            out.add(i)
            if i == b:
                break
            i = (i + 1) % 7
    return out


def _parse_times(spec: str) -> Optional[list[tuple[int, int]]]:
    out = []
    for part in spec.split(","):
        m = _TIME.match(part.strip())
        if not m:
            return None
        h1, m1, h2, m2 = map(int, m.groups())
        if h1 > 24 or h2 > 48 or m1 > 59 or m2 > 59:
            return None
        s, e = h1 * 60 + m1, h2 * 60 + m2
        if e <= s:          # e.g. 18:00-02:00 runs past midnight
            e += 1440
        out.append((s, e))
    return out


def parse(raw: Optional[str]) -> Optional[OpeningHours]:
    if not raw or not isinstance(raw, str):
        return None
    text = raw.strip()
    if text in ("24/7", "Mo-Su 00:00-24:00", "00:00-24:00"):
        return OpeningHours(raw=raw, always=True)
    oh = OpeningHours(raw=raw)
    for rule in [r.strip() for r in text.split(";") if r.strip()]:
        if rule.startswith("PH"):          # public holidays: ignored (unknowable here)
            continue
        tokens = rule.split()
        if len(tokens) == 1:
            dayset, rest = set(range(7)), tokens[0]
        elif len(tokens) == 2:
            dayset, rest = _parse_days(tokens[0]), tokens[1]
            if dayset is None:
                return None
        else:
            return None
        if rest in ("off", "closed"):
            for d in dayset:
                oh.days[d] = []
            continue
        if rest == "24/7":
            times = [(0, 1440)]
        else:
            times = _parse_times(rest)
        if times is None:
            return None
        for d in dayset:
            oh.days[d] = list(times)
    if not oh.days:
        return None
    if all(oh.days.get(d) == [(0, 1440)] for d in range(7)):
        oh.always = True
    return oh

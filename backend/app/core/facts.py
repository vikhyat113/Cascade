"""The Fact model: every piece of information the planner uses is a Fact.

A Fact never claims more than it knows. `value=None` means "we do not know";
the freshness engine turns that into UNKNOWN and nothing downstream is allowed
to substitute a made-up value (it must use an interval / worst case instead).
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

Status = Literal["KNOWN", "PROBABLE", "OUTDATED", "UNKNOWN"]
Kind = Literal["observed", "scheduled", "inferred", "prior"]

# Higher = more trustworthy. Weakest link = min rank.
STATUS_RANK: dict[str, int] = {"UNKNOWN": 0, "OUTDATED": 1, "PROBABLE": 2, "KNOWN": 3}
STATUSES: tuple[Status, ...] = ("KNOWN", "PROBABLE", "OUTDATED", "UNKNOWN")


class Fact(BaseModel):
    key: str                      # e.g. "traffic:cell:3_4", "poi:open:n123", "weather:now"
    value: Any = None
    source: str                   # "osm_map", "weather_forecast", "traffic_live", "prior", ...
    synthetic: bool
    observed_at: Optional[datetime] = None   # when the world was last observed
    ttl_s: int                    # how long it stays fresh (validity horizon for non-observed kinds)
    reliability: float = Field(ge=0.0, le=1.0)
    kind: Kind
    contradicted_by: Optional[str] = None    # key of a newer observation that disagrees
    note: Optional[str] = None


class FactView(BaseModel):
    """What reaches the API / UI for any fact."""
    key: str
    value: Any = None
    status: Status
    confidence: float
    source: str
    age_s: Optional[float] = None
    synthetic: bool
    kind: Optional[Kind] = None
    note: Optional[str] = None
    interval: Optional[tuple[float, float]] = None   # range the planner used (always for UNKNOWN)


def weakest(statuses) -> Status:
    statuses = list(statuses)
    if not statuses:
        return "UNKNOWN"
    return min(statuses, key=lambda s: STATUS_RANK[s])

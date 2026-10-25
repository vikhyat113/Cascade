"""Freshness engine: turns a Fact + "now" into KNOWN / PROBABLE / OUTDATED / UNKNOWN
and a confidence in [0, 1].

Rules (see SPEC section 5):
  KNOWN     observed, age <= ttl, reliability >= 0.7
  PROBABLE  scheduled / inferred / prior still inside its validity horizon,
            or observed with ttl < age <= 3*ttl (or fresh but low reliability)
  OUTDATED  observed with age > 3*ttl, non-observed past its horizon, or
            contradicted by a newer observation. Value kept, confidence discounted.
  UNKNOWN   no fact, value is None, or too old to use (age > 10*ttl).
            Never filled in: callers must widen intervals instead.

confidence = reliability * exp(-age / (decay_scale * ttl)), capped per kind, halved
when OUTDATED. decay_scale = 1 is the literal exp(-age/ttl); the default of 3 ties the
decay constant to the OUTDATED horizon so a just-expired fact keeps ~0.7 x reliability.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable, Optional, Union

from pydantic import BaseModel

from .facts import STATUS_RANK, STATUSES, Fact, FactView, Status


@dataclass(frozen=True)
class FreshnessConfig:
    known_min_reliability: float = 0.7
    outdated_factor: float = 3.0
    unusable_factor: float = 10.0
    coverage_threshold: float = 0.3
    outdated_discount: float = 0.5
    decay_scale: float = 3.0
    kind_caps: dict = field(default_factory=lambda: {
        "observed": 1.0, "scheduled": 0.8, "inferred": 0.65, "prior": 0.4})

    @classmethod
    def from_config(cls, cfg: dict) -> "FreshnessConfig":
        f = cfg.get("freshness", {})
        base = cls()
        return cls(
            known_min_reliability=f.get("known_min_reliability", base.known_min_reliability),
            outdated_factor=f.get("outdated_factor", base.outdated_factor),
            unusable_factor=f.get("unusable_factor", base.unusable_factor),
            coverage_threshold=f.get("coverage_threshold", base.coverage_threshold),
            outdated_discount=f.get("outdated_discount", base.outdated_discount),
            decay_scale=f.get("decay_scale", base.decay_scale),
            kind_caps={**base.kind_caps, **f.get("kind_caps", {})},
        )


DEFAULT = FreshnessConfig()


def age_s(fact: Optional[Fact], now: datetime) -> Optional[float]:
    if fact is None or fact.observed_at is None:
        return None
    return max(0.0, (now - fact.observed_at).total_seconds())


def status(fact: Optional[Fact], now: datetime, fc: FreshnessConfig = DEFAULT) -> Status:
    if fact is None or fact.value is None:
        return "UNKNOWN"
    age = age_s(fact, now)
    if age is None:
        # A fact we cannot age is only usable if it is a model prior.
        return "PROBABLE" if fact.kind == "prior" else "UNKNOWN"
    ttl = max(1, fact.ttl_s)
    if age > fc.unusable_factor * ttl:
        return "UNKNOWN"
    if fact.contradicted_by:
        return "OUTDATED"
    if fact.kind == "observed":
        if age <= ttl:
            return "KNOWN" if fact.reliability >= fc.known_min_reliability else "PROBABLE"
        if age <= fc.outdated_factor * ttl:
            return "PROBABLE"
        return "OUTDATED"
    # scheduled / inferred / prior: plausible while inside the validity horizon
    return "PROBABLE" if age <= ttl else "OUTDATED"


def confidence(fact: Optional[Fact], now: datetime, fc: FreshnessConfig = DEFAULT,
               st: Optional[Status] = None) -> float:
    st = st or status(fact, now, fc)
    if st == "UNKNOWN" or fact is None:
        return 0.0
    age = age_s(fact, now) or 0.0
    c = fact.reliability * math.exp(-age / (fc.decay_scale * max(1, fact.ttl_s)))
    c = min(c, fc.kind_caps.get(fact.kind, 1.0))
    if st == "OUTDATED":
        c *= fc.outdated_discount
    return round(max(0.0, min(1.0, c)), 4)


def view(fact: Optional[Fact], now: datetime, fc: FreshnessConfig = DEFAULT, *,
         key: Optional[str] = None, interval: Optional[tuple[float, float]] = None,
         source: str = "none", synthetic: bool = False, note: Optional[str] = None) -> FactView:
    """Serialisable view of a fact. A missing fact becomes an explicit UNKNOWN view."""
    if fact is None:
        return FactView(key=key or "unknown", value=None, status="UNKNOWN", confidence=0.0,
                        source=source, age_s=None, synthetic=synthetic, kind=None,
                        note=note or "no data", interval=interval)
    st = status(fact, now, fc)
    age = age_s(fact, now)
    return FactView(
        key=key or fact.key,
        # The hard rule: an UNKNOWN fact never carries a value to the UI.
        value=None if st == "UNKNOWN" else fact.value,
        status=st,
        confidence=confidence(fact, now, fc, st),
        source=fact.source,
        age_s=round(age, 1) if age is not None else None,
        synthetic=fact.synthetic,
        kind=fact.kind,
        note=note or fact.note,
        interval=interval,
    )


class Aggregate(BaseModel):
    status: Status
    confidence: float          # product (joint confidence of all items)
    min_confidence: float      # weakest single item
    weakest_key: Optional[str] = None
    n: int = 0


def aggregate_status(items: Iterable[Union[Fact, FactView, None]], now: Optional[datetime] = None,
                     fc: FreshnessConfig = DEFAULT) -> Aggregate:
    """Weakest-link status + confidence product. `None` items count as UNKNOWN."""
    views: list[FactView] = []
    for it in items:
        if isinstance(it, FactView):
            views.append(it)
        else:
            if now is None and it is not None:
                raise ValueError("now is required to aggregate raw facts")
            views.append(view(it, now, fc) if it is not None else view(None, now or datetime.min, fc))
    if not views:
        return Aggregate(status="UNKNOWN", confidence=0.0, min_confidence=0.0, n=0)
    weakest_v = min(views, key=lambda v: (STATUS_RANK[v.status], v.confidence))
    prod = 1.0
    for v in views:
        prod *= v.confidence
    return Aggregate(status=weakest_v.status, confidence=round(prod, 4),
                     min_confidence=round(min(v.confidence for v in views), 4),
                     weakest_key=weakest_v.key, n=len(views))


def coverage_status(weights: dict[str, float], threshold: float = DEFAULT.coverage_threshold) -> Status:
    """Status of a category spread over a route (weights = length per status).

    The weakest status whose cumulative share (counting it and everything weaker)
    reaches `threshold` wins. So a few unknown metres do not poison a route, but
    a third of it unknown does.
    """
    total = sum(max(0.0, w) for w in weights.values())
    if total <= 0:
        return "UNKNOWN"
    cum = 0.0
    for st in sorted(STATUSES, key=lambda s: STATUS_RANK[s]):  # UNKNOWN first
        cum += max(0.0, weights.get(st, 0.0)) / total
        if cum >= threshold - 1e-9:
            return st
    return "KNOWN"


def status_shares(weights: dict[str, float]) -> dict[str, float]:
    total = sum(weights.values()) or 1.0
    return {s: round(weights.get(s, 0.0) / total, 3) for s in STATUSES}

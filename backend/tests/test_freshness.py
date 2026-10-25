import math
from datetime import datetime, timedelta, timezone

import pytest

from app.core.facts import Fact
from app.core.freshness import (DEFAULT, FreshnessConfig, aggregate_status, confidence,
                                coverage_status, status, view)

NOW = datetime(2026, 10, 26, 2, 0, tzinfo=timezone.utc)


def fact(age_s=0, ttl=120, rel=0.9, kind="observed", value=1.0, **kw):
    return Fact(key="t", value=value, source="test", synthetic=True,
                observed_at=NOW - timedelta(seconds=age_s), ttl_s=ttl, reliability=rel, kind=kind, **kw)


# ---- the four statuses -------------------------------------------------------

def test_known_when_fresh_observed_and_reliable():
    assert status(fact(age_s=60), NOW) == "KNOWN"
    assert status(fact(age_s=120), NOW) == "KNOWN"          # boundary age == ttl


def test_probable_when_slightly_stale_or_unreliable():
    assert status(fact(age_s=121), NOW) == "PROBABLE"
    assert status(fact(age_s=360), NOW) == "PROBABLE"       # 3 * ttl boundary
    assert status(fact(age_s=10, rel=0.6), NOW) == "PROBABLE"  # fresh but unreliable


def test_probable_for_schedules_inferences_and_priors():
    for kind in ("scheduled", "inferred", "prior"):
        assert status(fact(age_s=100, ttl=3600, kind=kind), NOW) == "PROBABLE"


def test_outdated_when_old_or_contradicted():
    assert status(fact(age_s=361), NOW) == "OUTDATED"
    assert status(fact(age_s=7200, ttl=3600, kind="scheduled"), NOW) == "OUTDATED"
    assert status(fact(age_s=5, kind="scheduled", ttl=3600, contradicted_by="rt:1"), NOW) == "OUTDATED"


def test_unknown_when_missing_null_or_unusable():
    assert status(None, NOW) == "UNKNOWN"
    assert status(fact(value=None), NOW) == "UNKNOWN"
    assert status(fact(age_s=120 * 10 + 1), NOW) == "UNKNOWN"


def test_unknown_view_never_carries_a_value():
    v = view(fact(age_s=99999), NOW)
    assert v.status == "UNKNOWN" and v.value is None and v.confidence == 0.0
    missing = view(None, NOW, key="weather:now", interval=(0.0, 0.7))
    assert missing.status == "UNKNOWN" and missing.value is None and missing.interval == (0.0, 0.7)


# ---- confidence decay --------------------------------------------------------

def test_confidence_decays_monotonically_with_age():
    ages = [0, 30, 60, 120, 240, 360, 600, 1199]
    confs = [confidence(fact(age_s=a), NOW) for a in ages]
    assert all(a >= b for a, b in zip(confs, confs[1:]))
    assert confs[0] == pytest.approx(0.9, abs=1e-3)              # reliability at age 0
    assert confs[3] == pytest.approx(0.9 * math.exp(-1 / DEFAULT.decay_scale), abs=1e-3)


def test_literal_spec_decay_when_scale_is_one():
    fc = FreshnessConfig(decay_scale=1.0)
    assert confidence(fact(age_s=120), NOW, fc) == pytest.approx(0.9 * math.exp(-1), abs=1e-3)


def test_confidence_capped_by_kind_and_discounted_when_outdated():
    assert confidence(fact(kind="prior", rel=1.0, ttl=10**6), NOW) <= DEFAULT.kind_caps["prior"]
    assert confidence(fact(kind="scheduled", rel=1.0, ttl=10**6), NOW) <= DEFAULT.kind_caps["scheduled"]
    fresh_like = 0.9 * math.exp(-(361 / 120) / DEFAULT.decay_scale)
    assert confidence(fact(age_s=361), NOW) == pytest.approx(fresh_like * DEFAULT.outdated_discount, abs=1e-3)


def test_future_observation_is_treated_as_age_zero():
    assert status(fact(age_s=-30), NOW) == "KNOWN"


# ---- aggregation ---------------------------------------------------------------

def test_aggregate_is_weakest_link_and_product():
    a = fact(age_s=0, rel=0.9)
    b = fact(age_s=200, rel=0.9)
    agg = aggregate_status([a, b], NOW)
    assert agg.status == "PROBABLE"
    assert agg.confidence == pytest.approx(confidence(a, NOW) * confidence(b, NOW), abs=1e-3)
    assert aggregate_status([a, None], NOW).status == "UNKNOWN"
    assert aggregate_status([], NOW).status == "UNKNOWN"


def test_coverage_status_threshold():
    assert coverage_status({"KNOWN": 0.9, "UNKNOWN": 0.1}) == "KNOWN"
    assert coverage_status({"KNOWN": 0.6, "UNKNOWN": 0.4}) == "UNKNOWN"
    assert coverage_status({"KNOWN": 0.6, "PROBABLE": 0.2, "UNKNOWN": 0.2}) == "PROBABLE"
    assert coverage_status({"KNOWN": 0.65, "OUTDATED": 0.2, "UNKNOWN": 0.15}) == "OUTDATED"
    assert coverage_status({}) == "UNKNOWN"

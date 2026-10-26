"""The plain-language mapping (UI_SPEC §4): fixture plans for each rule, plus an end-to-end
check on the tiny test city that no sentence uses a banned word or runs too long."""
import copy
import json
from datetime import datetime, timedelta, timezone

import pytest

from app.core import planner
from app.core.sim import events
from app.presentation.simple_view import (SimpleView, banned_hits, banner_key, load_copy, place_state,
                                          plain_violations, present, user_texts)

TZ = timezone(timedelta(hours=5, minutes=30))
NOW = datetime(2026, 10, 26, 2, 0, tzinfo=TZ)
CFG = {"presentation": {"safe_min": 66, "ok_min": 55, "banner_max_age_s": 600}}


def iso(h, m):
    return datetime(2026, 10, 26, h, m, tzinfo=TZ).isoformat()


def cat(name, status, critical=True, detail="", conf=0.6):
    return {"name": name, "label": name, "status": status, "confidence": conf, "detail": detail, "critical": critical}


def fixture_plan(pid="p1", kind="bus", labels=("Recommended", "Safest"), safety_lo=70, feasible=(True, True, True),
                 cats=None, walk_m=800, risk=None):
    risk = risk or {c: {"lo": 0.1, "hi": 0.3} for c in ("lighting", "incident", "isolation", "traffic", "weather", "emergency")}
    cats = cats or [cat("closures", "KNOWN")]
    rank = {"UNKNOWN": 0, "OUTDATED": 1, "PROBABLE": 2, "KNOWN": 3}
    crit = [c for c in cats if c["critical"]]
    limiting = min(crit, key=lambda c: rank[c["status"]])["name"] if crit else None
    seg = lambda mode, a, b, **kw: {"mode": mode, "label": mode, "from": "A", "to": kw.pop("to", "Sector 28"),  # noqa: E731
                                     "start": {"best": a, "expected": a, "worst": a}, "end": {"best": b, "expected": b, "worst": b},
                                     "duration_s": {"best": 300, "expected": 360, "worst": 420}, "distance_m": 420,
                                     "geometry": [[77.32, 28.57], [77.33, 28.58]], "risk": {}, "safety": {"lo": 60, "hi": 80},
                                     "status": "KNOWN", "facts": [], **kw}
    return {
        "id": pid, "kind": kind, "labels": list(labels), "title": f"{kind} way",
        "eta": {"best": iso(2, 40), "expected": iso(2, 45), "worst": iso(2, 55)},
        "duration_min": {"best": 25, "expected": 30, "worst": 40},
        "feasible": dict(zip(("best", "expected", "worst"), feasible)),
        "safety": {"lo": safety_lo, "hi": safety_lo + 15}, "risk": risk,
        "trust": {"status": "KNOWN", "confidence": 0.7, "limiting": limiting, "overall": "KNOWN",
                  "categories": cats},
        "segments": [seg("walk", iso(2, 15), iso(2, 21)),
                     seg("wait", iso(2, 21), iso(2, 25), route_id="N1", haven=None),
                     seg("bus", iso(2, 25), iso(2, 40), route_id="N1", to="12/22"),
                     seg("walk", iso(2, 40), iso(2, 45), to="Home (Dharampeth)")],
        "walk_m": walk_m, "distance_m": 4000, "outdoor_min": 12, "warnings": [], "safe_havens": [],
        "open_along": [], "depends_on": [c["name"] for c in crit],
    }


def fixture_set(*plans, deadline=iso(3, 0), log=None):
    return {"id": "x", "phase": "before_departure", "departure": iso(2, 15), "deadline": deadline, "user_locked": True,
            "plans": list(plans), "recommended_id": plans[0]["id"] if plans else None,
            "change_log": log or [], "notes": [], "havens_near_origin": []}


def view(ps, lang="en", now=NOW):
    return SimpleView(ps, lang=lang, now=now, cfg=CFG, dest={"name": "Home (Dharampeth)", "kind": "home"}).build()


def opt(v, oid="safest"):
    return next(o for o in v["options"] if o["id"] == oid)


# ---- rules ----------------------------------------------------------------------------------------------

def test_copy_files_load_and_match():
    en, hi = load_copy("en"), load_copy("hi")
    assert en and set(en) == set(hi)


def test_arrive_text_and_timing():
    v = view(fixture_set(fixture_plan()))
    o = opt(v)
    assert o["arrive_text"] == "Home by 2:45" and o["timing"] == "on_time" and o["timing_text"] == "On time"
    late = opt(view(fixture_set(fixture_plan(feasible=(True, True, False)))))
    assert late["timing"] == "maybe_late" and late["late_text"] == "Maybe 2:55"
    gone = opt(view(fixture_set(fixture_plan(feasible=(False, False, False)))))
    assert gone["timing"] == "too_late" and gone["timing_text"] == "Too late"
    assert opt(view(fixture_set(fixture_plan(), deadline=None)))["timing"] == "none"


@pytest.mark.parametrize("lo,level", [(80, "safe"), (66, "safe"), (65, "ok"), (55, "ok"), (54, "careful")])
def test_safety_level_from_worst_case_score(lo, level):
    assert opt(view(fixture_set(fixture_plan(safety_lo=lo))))["safety_level"] == level


def test_no_warning_when_everything_is_sure():
    o = opt(view(fixture_set(fixture_plan(cats=[cat("transit_timing", "KNOWN"), cat("closures", "KNOWN")]))))
    assert o["warning"] is None


def test_bus_on_timetable_only_says_bus_time_is_a_guess_with_backup():
    bus = fixture_plan(cats=[cat("transit_timing", "PROBABLE", detail="N1 2:34: timetable only (no realtime)"),
                             cat("closures", "KNOWN")])
    cab = fixture_plan("p2", kind="cab", labels=("Fastest",), safety_lo=68)
    o = opt(view(fixture_set(bus, cab)))
    assert o["warning"]["text"] == "Bus time is a guess." and o["warning"]["pill"] == "Likely"
    assert o["warning"]["backup_option_id"] == "fastest"


def test_probable_cab_wait_is_normal_unless_it_could_make_you_late():
    ok = fixture_plan(kind="cab", cats=[cat("cab_availability", "PROBABLE"), cat("closures", "KNOWN")])
    assert opt(view(fixture_set(ok)))["warning"] is None
    late = fixture_plan(kind="cab", feasible=(True, True, False),
                        cats=[cat("cab_availability", "PROBABLE"), cat("closures", "KNOWN")])
    assert opt(view(fixture_set(late)))["warning"]["text"] == "Cab wait is a guess."


@pytest.mark.parametrize("status,text,pill", [("OUTDATED", "Traffic info is old.", "Old info"),
                                              ("UNKNOWN", "Not sure about traffic.", "Not sure")])
def test_old_or_unknown_critical_info_is_flagged(status, text, pill):
    p = fixture_plan(kind="cab", cats=[cat("traffic", status), cat("closures", "KNOWN")])
    w = opt(view(fixture_set(p)))["warning"]
    assert (w["text"], w["pill"]) == (text, pill)


def test_unknown_lights_on_a_long_walk():
    p = fixture_plan(kind="walk", cats=[cat("closures", "KNOWN"), cat("lighting", "UNKNOWN", critical=False)])
    assert opt(view(fixture_set(p)))["warning"]["text"] == "Not sure about lights."


def test_reason_uses_real_factors_and_never_claims_unmapped_lights():
    p = fixture_plan(kind="walk", safety_lo=70, cats=[cat("closures", "KNOWN"), cat("lighting", "PROBABLE", critical=False)])
    p["open_along"] = [{"id": "s1", "cat": "shop", "name": "Shop", "lat": 0, "lon": 0, "dist_m": 20,
                        "open": {"status": "KNOWN", "value": True}}]
    r = opt(view(fixture_set(p)))["safety_reason"]
    assert "main roads" in r.lower() and "shops open on the way" in r.lower() and "lit" not in r.lower()
    dark = fixture_plan(kind="walk", safety_lo=40, walk_m=2600,
                        risk={c: {"lo": 0.5, "hi": 0.7} for c in ("lighting", "incident", "isolation", "traffic", "weather", "emergency")},
                        cats=[cat("closures", "KNOWN"), cat("lighting", "UNKNOWN", critical=False)])
    assert opt(view(fixture_set(dark)))["safety_level"] == "careful"


def test_steps_are_icons_minutes_and_plain_text():
    steps = opt(view(fixture_set(fixture_plan())))["steps"]
    assert [s["icon"] for s in steps] == ["walk", "wait", "bus", "walk"]
    assert steps[0]["text"] == "Walk 420 m to Sector 28"
    assert steps[2]["text"] == "Bus N1 to 12/22" and steps[3]["text"].endswith("to Home")


def test_banner_comes_from_newest_plan_change_only():
    log = [{"t": iso(1, 58), "code": "switch.closure", "message": "x"},
           {"t": iso(1, 59), "code": "status.traffic.OUTDATED", "message": "y"}]
    b = view(fixture_set(fixture_plan(), log=log))["banner"]
    assert b["text"] == "Road ahead is closed. New way found." and b["see_option_id"] == "safest"
    assert view(fixture_set(fixture_plan(), log=log), now=NOW + timedelta(minutes=30))["banner"] is None
    assert banner_key("status.traffic.OUTDATED") is None and banner_key("feas.miss.worst") == "line.mayBeLate"


def test_place_states():
    assert place_state({"status": "KNOWN", "value": True}) == "open"
    assert place_state({"status": "PROBABLE", "value": True}) == "maybe_open"
    assert place_state({"status": "UNKNOWN", "value": None}) == "not_sure"
    assert place_state({"status": "KNOWN", "value": False}) is None


def test_hindi_sentences():
    o = opt(view(fixture_set(fixture_plan()), lang="hi"))
    assert o["arrive_text"] == "2:45 तक घर" and o["timing_text"] == "समय पर"


# ---- end to end on the tiny city ------------------------------------------------------------------

def check_plain(v):
    assert user_texts(v), "the view should say something"
    assert plain_violations(v) == []


def test_banned_word_check_catches_engineer_words():
    assert set(banned_hits("ETA uncertain: feed is stale")) == {"eta", "feed", "stale"}
    assert banned_hits("Bus time is a guess.") == []


def test_live_engine_view_is_plain_and_reacts_to_lost_bus_info(engine, corners):
    sw, ne = corners
    req = planner.PlanRequest(origin=planner.Point(lat=sw["lat"], lon=sw["lon"], name=sw["name"]),
                              destination=planner.Point(lat=ne["lat"], lon=ne["lon"], name="Home", kind="home"),
                              finish_time="02:10", deadline="02:50",
                              prefs=planner.Prefs(modes=["walk", "bus"], risk_weight=1.0))
    ap = engine.replanner.create(req)
    s = engine.state
    v = present(ap.planset, lang="en", now=s.now(), cfg=engine.static.cfg, connection="live",
                dest=req.destination.model_dump())
    check_plain(v)
    assert v["details"]["plans"] and {o["id"] for o in v["options"] if o["tab"]} == {"safest", "balanced", "fastest"}
    events.set_source(s, "transit_realtime", False)
    engine.advance(120 * 11)
    v2 = present(ap.planset, lang="en", now=s.now(), cfg=engine.static.cfg, connection="live",
                 dest=req.destination.model_dump())
    check_plain(v2)
    bus = [o for o in v2["options"] if o["kind"] == "bus"]
    assert bus and bus[0]["warning"]["text"] == "Bus time is a guess."
    json.dumps(v2)                      # serialisable for the API / SSE


def test_no_banner_before_the_user_starts_the_trip():
    log = [{"t": iso(1, 59), "code": "switch.better", "message": "x"}]
    ps = fixture_set(fixture_plan(), log=log)
    ps["user_locked"] = False
    assert view(ps)["banner"] is None

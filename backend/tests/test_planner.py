import json
from datetime import datetime

from app.core import planner
from app.core.nlp import parse_rules
from app.core.sim import events
from app.core.validate import validate_planset


def request(corners, **kw):
    sw, ne = corners
    return planner.PlanRequest(origin=planner.Point(lat=sw["lat"], lon=sw["lon"], name=sw["name"]),
                               destination=planner.Point(lat=ne["lat"], lon=ne["lon"], name=ne["name"]),
                               finish_time=kw.pop("finish_time", "02:10"), deadline=kw.pop("deadline", "02:50"),
                               prefs=planner.Prefs(**kw))


def plans_of(ps):
    return {p["id"]: p for p in ps["plans"]}


def test_plan_has_labelled_ranked_options_with_ranges(engine, corners):
    ps, _ = planner.plan(engine.state, request(corners), engine.cache)
    labels = {l for p in ps["plans"] for l in p["labels"]}
    assert {"Recommended", "Fastest", "Safest"} <= labels
    for p in ps["plans"]:
        e = p["eta"]
        assert e["best"] <= e["expected"] <= (e["worst"] or "9999")
        assert p["safety"]["lo"] <= p["safety"]["hi"]
        assert p["explanation"] and p["trust"]["status"] in ("KNOWN", "PROBABLE", "OUTDATED", "UNKNOWN")
    assert validate_planset(json.loads(json.dumps(ps, default=str))) == []


def test_safest_walk_prefers_lit_ring_over_unknown_lanes(engine, corners):
    ps, specs, all_plans = planner.plan_full(engine.state, request(corners, modes=["walk"]), engine.cache)
    walks = [p for p in all_plans if p["kind"] == "walk"]
    fastest = min(walks, key=lambda p: p["duration_min"]["expected"])
    safest = max(walks, key=lambda p: p["safety"]["lo"])
    assert safest["safety"]["lo"] >= fastest["safety"]["lo"]
    assert fastest["duration_min"]["expected"] <= safest["duration_min"]["expected"]
    lit = {c["name"]: c for c in safest["trust"]["categories"]}["lighting"]
    assert lit["status"] in ("KNOWN", "PROBABLE")      # mostly on the mapped-lit ring


def test_feasibility_uses_deadline(engine, corners):
    ok, _ = planner.plan(engine.state, request(corners, deadline="03:30"), engine.cache)
    tight, _ = planner.plan(engine.state, request(corners, deadline="02:12"), engine.cache)
    assert ok["feasibility_level"] == "worst"
    assert tight["no_feasible"] and tight["warnings"]


def test_bus_falls_back_to_timetable_when_realtime_dies(engine, corners):
    req = request(corners, modes=["walk", "bus"], risk_weight=0.5)
    s = engine.state
    events.set_source(s, "transit_realtime", False)
    engine.advance(120 * 11)                     # realtime facts become unusable
    _, _, plans = planner.plan_full(s, req, engine.cache)
    bus = [p for p in plans if p["kind"] == "bus"]
    assert bus, "a bus plan should still be produced from the timetable"
    tt = {c["name"]: c for c in bus[0]["trust"]["categories"]}["transit_timing"]
    assert tt["status"] == "PROBABLE" and "timetable" in tt["detail"]


def test_total_live_loss_still_plans_with_lower_confidence(engine, corners):
    s = engine.state
    req = request(corners, deadline="03:40")
    before, _ = planner.plan(s, req, engine.cache)
    events.set_source(s, "all_live", False)
    engine.advance(3600)
    after, _ = planner.plan(s, req, engine.cache)
    rb = plans_of(before)[before["recommended_id"]]
    ra = plans_of(after)[after["recommended_id"]]
    assert ra["trust"]["confidence"] < rb["trust"]["confidence"]
    assert ra["trust"]["status"] in ("OUTDATED", "UNKNOWN")
    assert validate_planset(json.loads(json.dumps(after, default=str))) == []


def test_replanner_switches_on_closure_and_logs_why(engine, corners):
    s = engine.state
    ap = engine.replanner.create(request(corners, modes=["walk", "cab"]))
    rec = plans_of(ap.planset)[ap.planset["recommended_id"]]
    events.apply(s, {"type": "road_closure", "params": {"edge_selector": "main_road_nearest_route"}},
                 events.plan_context(ap))
    engine.advance(60)
    new = ap.planset["recommended_id"]
    kinds = [e["kind"] for e in ap.log]
    assert "event" in kinds and new is not None
    if rec["kind"] == "cab":                       # barricade blocks vehicles: the cab route must change
        assert new != rec["id"] and "switch" in kinds
        assert any("closure" in e["message"] for e in ap.log if e["kind"] == "switch")


def test_hysteresis_keeps_plan_on_noise(engine, corners):
    ap = engine.replanner.create(request(corners))
    first = ap.planset["recommended_id"]
    for _ in range(5):
        engine.advance(30)
    assert ap.planset["recommended_id"] == first
    assert not [e for e in ap.log if e["kind"] == "switch"]


def test_unknown_hours_pharmacy_is_never_called_open(engine, corners):
    from app.core.needs import need_now
    sw, _ = corners
    res = need_now(engine, "pharmacy", sw["lat"], sw["lon"])
    ph = res["results"][0]
    assert ph["open"]["status"] == "UNKNOWN" and ph["open"]["value"] is None
    assert "UNKNOWN" in ph["explanation"]
    hosp = need_now(engine, "hospital", sw["lat"], sw["lon"])["results"][0]
    assert hosp["open"]["value"] is True and hosp["open"]["status"] == "KNOWN"


def test_nl_rules_parse_spec_example():
    r = parse_rules("I finish at 2:15 and need to reach Sector 12 by 3")
    assert (r.finish_time, r.deadline, r.destination_text) == ("02:15", "03:00", "Sector 12")
    h = parse_rules("I finish work at 2:15 AM, need home by 3:00 AM, no cab")
    assert (h.finish_time, h.deadline, h.destination_text, h.modes) == ("02:15", "03:00", "home", ["walk", "bus"])

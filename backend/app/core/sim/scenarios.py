"""Deterministic scenario replay + stress harness (scenarios/*.json).

Each scenario builds a fresh Engine on a ManualClock (sharing the loaded
StaticWorld), replays its events minute by minute, validates every plan set it
produces (validate.validate_planset) and checks the scenario's expectations.
"""
from __future__ import annotations

import json
import time
from datetime import timedelta
from pathlib import Path

from ...config import ROOT_DIR
from ..clock import ManualClock, hhmm, to_night
from ..facts import STATUS_RANK
from ..planner import PlanRequest, Point, Prefs
from ..validate import validate_json, validate_planset
from . import events as ev_mod

SCEN_DIR = ROOT_DIR / "scenarios"


def load_all() -> list[dict]:
    out = []
    for p in sorted(SCEN_DIR.glob("*.json")):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            continue
    return out


def _point(static, spec) -> Point:
    if isinstance(spec, dict):
        return Point(**spec)
    hits = static.geocode(str(spec), 1)
    if not hits:
        raise ValueError(f"cannot resolve '{spec}' in the offline gazetteer")
    return Point(lat=hits[0]["lat"], lon=hits[0]["lon"], name=hits[0]["name"])


def build_request(static, sc: dict) -> PlanRequest:
    r = dict(sc["request"])
    prefs = {}
    if "persona" in r:
        per = next(p for p in static.personas if p["id"] == r["persona"])
        r.setdefault("origin", per["origin_point"])
        r.setdefault("destination", per["home_point"])
        r.setdefault("finish_time", per["finish_time"])
        r.setdefault("deadline", per["deadline"])
        prefs = {"risk_weight": per["risk_weight"], "modes": per["modes"], "max_walk_m": per["max_walk_m"]}
    prefs.update(r.get("prefs", {}))
    return PlanRequest(origin=_point(static, r["origin"]), destination=_point(static, r["destination"]),
                       finish_time=r.get("finish_time"), start_time=r.get("start_time"), deadline=r.get("deadline"),
                       persona=r.get("persona"), prefs=Prefs(**prefs))


def _rec(ps: dict):
    return next((p for p in ps["plans"] if p["id"] == ps["recommended_id"]), None)


def run(static, sc: dict) -> dict:
    from ..engine import Engine        # local import: engine imports this package
    from .. import needs
    from ...presentation.simple_view import connection_state, plain_violations, present

    t_wall = time.time()
    req = build_request(static, sc)
    night, tz = static.night, static.tz
    finish = to_night(req.finish_time or req.start_time or "02:00", night, tz)
    start = to_night(sc["start"], night, tz) if sc.get("start") else finish - timedelta(minutes=10)
    deadline = to_night(req.deadline, night, tz) if req.deadline else finish + timedelta(minutes=45)
    end = to_night(sc["end"], night, tz) if sc.get("end") else deadline + timedelta(minutes=5)
    clock = ManualClock(start)
    eng = Engine(cfg=static.cfg, static=static, clock=clock, live=False, warmup=False, seed=sc.get("seed", 42))
    s = eng.state
    if sc.get("offline_start"):
        ev_mod.set_source(s, "all_live", False)
    for sid in sc.get("unavailable", []):
        ev_mod.set_source(s, sid, False)
    if not sc.get("offline_start"):
        eng.feeds.warmup(300)
    eng._last = clock.now()
    ap = eng.replanner.create(req)
    pending = sorted(sc.get("events", []), key=lambda e: to_night(e["t"], night, tz))
    step = float(sc.get("step_s", 60))
    samples, violations = [], []
    planb_seen = bool(ap.planset.get("plan_b"))
    conflict_seen = False
    first = _rec(ap.planset)
    conf0 = first["trust"]["confidence"] if first else 0.0

    def sample():
        nonlocal planb_seen, conflict_seen
        ps = json.loads(json.dumps(ap.planset, default=str))
        simple = present(ps, lang="en", now=clock.now(), cfg=static.cfg, connection=connection_state(s),
                         dest=req.destination.model_dump())
        for v in validate_planset(ps) + [f"simple view: {x}" for x in plain_violations(simple)]:
            if len(violations) < 20:
                violations.append(f"{hhmm(clock.now())} {v}")
        rec = _rec(ps)
        planb_seen |= bool(ps.get("plan_b"))
        conflict_seen |= any("Conflicting sources" in w for p in ps["plans"] for w in p.get("warnings", []))
        samples.append({"t": hhmm(clock.now()), "has_plan": rec is not None,
                        "title": rec["title"] if rec else None,
                        "status": rec["trust"]["status"] if rec else "UNKNOWN",
                        "confidence": rec["trust"]["confidence"] if rec else 0.0,
                        "safety_lo": rec["safety"]["lo"] if rec else None,
                        "feasible": rec["feasible"] if rec else None,
                        "categories": {c["name"]: c["status"] for c in rec["trust"]["categories"]} if rec else {}})

    sample()
    applied = []
    while clock.now() < end:
        while pending and to_night(pending[0]["t"], night, tz) <= clock.now():
            e = pending.pop(0)
            res = ev_mod.apply(s, e, ev_mod.plan_context(ap))
            applied.append(f"{e['t']} {e['type']}" + (f" ({res['error']})" if "error" in res else ""))
        eng.advance(step, step=step)
        sample()

    check_results = []
    for chk in sc.get("checks", []):
        if chk.get("t"):
            pass
        if chk["type"] == "need_now":
            if chk.get("disable"):
                ev_mod.set_source(s, chk["disable"], False)
            res = needs.need_now(eng, chk["kind"], req.origin.lat, req.origin.lon)
            items = res["results"] + res.get("closed_nearby", [])
            bad = validate_json(res, "need_now")
            unknown_claimed_open = [r["name"] for r in res["results"]
                                    if r["open"]["status"] == "UNKNOWN" and "UNKNOWN" not in r["explanation"]]
            sure = [r for r in res["results"] if r["open"]["status"] in ("KNOWN", "PROBABLE") and r["open"]["value"]]
            top_ok = not sure or res["results"][0] in sure
            ok = not bad and not unknown_claimed_open and top_ok
            check_results.append({"check": f"need_now:{chk['kind']}" + (f" (no {chk['disable']})" if chk.get("disable") else ""),
                                  "pass": ok, "unknown_hours_listed": sum(1 for r in items if r["open"]["status"] == "UNKNOWN"),
                                  "top": res["results"][0]["name"] + f" [{res['results'][0]['open']['status']}]"
                                  if res["results"] else None, "violations": bad[:3]})
            violations += [f"need_now {v}" for v in bad[:5]]

    transitions = [f"{e['hhmm']} {e['message']}" for e in ap.log if e["kind"] == "status"]
    switches = [f"{e['hhmm']} {e['message']}" for e in ap.log if e["kind"] == "switch"]
    final = samples[-1]
    min_conf = min(x["confidence"] for x in samples)
    worst_status = min((x["status"] for x in samples), key=lambda st: STATUS_RANK[st])
    exp = sc.get("expect", {})
    checks = {}

    def chk(name, ok, detail=""):
        checks[name] = {"pass": bool(ok), "detail": detail}

    if exp.get("never_status_unknown_as_value"):
        bad = [v for v in violations if "UNKNOWN" in v]
        chk("never_status_unknown_as_value", not bad, bad[0] if bad else "no UNKNOWN fact carried a value")
    if "plan_b_offered" in exp:
        chk("plan_b_offered", planb_seen == exp["plan_b_offered"], f"seen={planb_seen}")
    if "plan_changed" in exp:
        chk("plan_changed", bool(switches) == exp["plan_changed"], f"{len(switches)} switch(es)")
    if "still_feasible" in exp:
        want = exp["still_feasible"]
        f = final["feasible"] or {}
        ok = {"yes": f.get("worst"), "maybe": final["has_plan"], "no": not f.get("best")}.get(want, True)
        chk("still_feasible", ok, f"final feasibility {f}")
    if exp.get("always_has_plan"):
        chk("always_has_plan", all(x["has_plan"] for x in samples), f"{sum(x['has_plan'] for x in samples)}/{len(samples)}")
    if exp.get("confidence_drops"):
        chk("confidence_drops", conf0 - min_conf >= 0.1, f"{conf0:.2f} -> {min_conf:.2f}")
    if exp.get("safety_drops"):
        lows = [x["safety_lo"] for x in samples if x["safety_lo"] is not None]
        chk("safety_drops", lows and min(lows) <= lows[0] - 3, f"worst-case safety {lows[0]} -> {min(lows)}")
    if exp.get("min_status"):
        chk("min_status", STATUS_RANK[worst_status] <= STATUS_RANK[exp["min_status"]], f"weakest seen {worst_status}")
    if exp.get("conflict_flagged"):
        chk("conflict_flagged", conflict_seen, "conflict warning shown" if conflict_seen else "no conflict warning")
    for cat, st in (exp.get("status_reaches") or {}).items():
        seen = [x["categories"].get(cat) for x in samples if x["categories"].get(cat)]
        hit = any(STATUS_RANK[v] <= STATUS_RANK[st] for v in seen)
        chk(f"{cat}_reaches_{st}", hit, f"seen {sorted(set(seen), key=lambda v: STATUS_RANK[v])}")
    for c in check_results:
        chk(c["check"], c["pass"], f"top={c['top']}, unknown-hours listed={c['unknown_hours_listed']}")
    if not violations:
        checks.setdefault("valid_output", {"pass": True, "detail": "all outputs passed validation"})
    else:
        checks["valid_output"] = {"pass": False, "detail": violations[0]}
    return {
        "id": sc["id"], "name": sc.get("name", sc["id"]), "description": sc.get("description", ""),
        "steps": len(samples), "events_applied": applied,
        "plan_changed": bool(switches), "switches": switches[:6], "status_transitions": transitions[:12],
        "n_transitions": len(transitions),
        "initial": {"title": samples[0]["title"], "status": samples[0]["status"], "confidence": samples[0]["confidence"]},
        "final": {"title": final["title"], "status": final["status"], "confidence": final["confidence"],
                  "safety_lo": final["safety_lo"], "feasible": final["feasible"]},
        "max_confidence_drop": round(max(0.0, conf0 - min_conf), 3), "weakest_status": worst_status,
        "plan_b_offered": planb_seen, "invalid_outputs": len(violations), "violations": violations[:5],
        "checks": checks, "passed": all(c["pass"] for c in checks.values()),
        "timeline": [{k: x[k] for k in ("t", "status", "confidence", "safety_lo", "title")} for x in samples],
        "duration_ms": round((time.time() - t_wall) * 1000),
    }

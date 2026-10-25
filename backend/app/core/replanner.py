"""Continuous re-planning with a change log and hysteresis.

Every tick each active plan is recomputed. The currently recommended route is
"pinned" and always re-evaluated, so we can compare like with like. We only
switch when the current plan breaks (closure, cancelled trip, misses the
deadline), when its critical data degrades to OUTDATED/UNKNOWN, or when an
alternative is clearly better (>= hysteresis_points of worst-case safety, or
>= hysteresis_eta_s faster at similar safety). Everything is logged.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

from . import planner
from .clock import hhmm, to_night
from .facts import STATUS_RANK
from .planner import CATEGORY_LABEL, PlanRequest, RouteSpec


@dataclass
class ActivePlan:
    id: str
    request: PlanRequest
    created_at: datetime
    planset: Optional[dict] = None
    pinned: Optional[RouteSpec] = None
    version: int = 0
    log: list = field(default_factory=list)
    prev_cats: dict = field(default_factory=dict)
    prev_eta: Optional[str] = None
    prev_feas: Optional[dict] = None
    prev_planb: Optional[str] = None
    prev_rec_id: Optional[str] = None
    pending: dict = field(default_factory=dict)     # debounced category transitions
    done: bool = False
    kept_note: Optional[str] = None
    event_seq: int = 0
    last_access: float = field(default_factory=time.monotonic)
    history: list = field(default_factory=list)       # (t, confidence, safety_lo) for charts
    specs: dict = field(default_factory=dict)         # plan id -> RouteSpec from the last re-plan
    user_locked: bool = False                         # the user picked this way: only switch if it breaks


def _feas_rank(p: dict) -> int:
    f = p["feasible"]
    return 3 if f["worst"] else 2 if f["expected"] else 1 if f["best"] else 0


def _eta_min(p: dict) -> float:
    return p["duration_min"]["expected"] if p["duration_min"]["expected"] is not None else 1e9


class Replanner:
    def __init__(self, engine):
        self.engine = engine
        self.plans: dict[str, ActivePlan] = {}     # re-planned every tick
        self.parked: dict[str, ActivePlan] = {}    # nobody watching: frozen until opened again

    @property
    def state(self):
        return self.engine.state

    def _entry(self, ap: ActivePlan, kind: str, message: str, severity: str = "info",
               at: Optional[datetime] = None, code: Optional[str] = None, **extra) -> dict:
        """Log entry. `code` is the machine-readable reason the simple UI turns into plain words."""
        now = at or self.state.now()
        e = {"t": now.isoformat(timespec="seconds"), "hhmm": hhmm(now), "kind": kind, "severity": severity,
             "message": message, "code": code or kind, **extra}
        ap.log.append(e)
        if len(ap.log) > 300:
            del ap.log[:-300]
        return e

    # ---- lifecycle ------------------------------------------------------------------------
    def create(self, req: PlanRequest) -> ActivePlan:
        now = self.state.now()
        st = self.state.static
        req = req.model_copy(deep=True)
        night = (now - timedelta(hours=12)).date()
        txt = req.start_time or req.finish_time
        t = to_night(txt, night, st.tz) if txt else None
        note = None
        if t is None or t < now - timedelta(seconds=60):
            if t is not None:
                note = f"Requested {hhmm(t)} has already passed: planning from now ({hhmm(now)})"
            req.start_time, req.finish_time = now.isoformat(timespec="seconds"), None
        ap = ActivePlan(id=uuid.uuid4().hex[:10], request=req, created_at=now)
        ap.event_seq = self.state.event_seq
        if note:
            self._entry(ap, "info", note)
        self.recompute(ap, initial=True)
        self.plans[ap.id] = ap
        while len(self.plans) > 8:        # keep the live loop cheap
            oldest = min(self.plans.values(), key=lambda a: a.last_access)
            self.plans.pop(oldest.id, None)
        return ap

    def tick_all(self) -> None:
        cutoff = time.monotonic() - 120   # no viewer (SSE / GET) for 2 minutes -> stop re-planning it
        for pid in [k for k, a in self.plans.items() if a.last_access < cutoff]:
            self.parked[pid] = self.plans.pop(pid)
            if len(self.parked) > 50:
                self.parked.pop(next(iter(self.parked)))
        for ap in list(self.plans.values()):
            if ap.done:
                continue          # trip finished: freeze the last plan
            try:
                self.recompute(ap)
                if ap.planset and ap.planset.get("phase") == "arrived":
                    ap.done = True
                    self._entry(ap, "info", "Trip complete (worst-case arrival time has passed); plan frozen")
                    ap.planset["change_log"] = ap.log[-80:]
                    ap.version += 1
            except Exception as e:   # never let one plan kill the loop
                self._entry(ap, "info", f"re-plan failed: {e!r}", "warn")

    # ---- core ---------------------------------------------------------------------------------
    def recompute(self, ap: ActivePlan, initial: bool = False) -> list[dict]:
        s = self.state
        start_len = len(ap.log)
        ps, specs, all_plans = planner.plan_full(s, ap.request, self.engine.cache, pinned=ap.pinned)
        by_id = {p["id"]: p for p in all_plans}
        rec_id = ps["recommended_id"]
        for e in self.state.events_since(ap.event_seq):
            self._entry(ap, "event", e["message"], e["severity"], at=datetime.fromisoformat(e["t"]),
                        code=f"event.{e['kind']}")
        ap.event_seq = self.state.event_seq

        if initial or ap.pinned is None:
            if rec_id:
                r = by_id[rec_id]
                self._entry(ap, "info", f"Plan: {r['title']}, arrive {_eta(r)}, worst-case safety "
                                        f"{r['safety']['lo']}, data {r['trust']['status']}", code="plan.new")
            else:
                self._entry(ap, "info", "No route found", "alert", code="plan.none")
        else:
            cur = by_id.get(ap.pinned.sig)
            if cur is None:
                why = ps.get("pinned_invalid") or "no longer available"
                if rec_id:
                    self._entry(ap, "switch", f"Current plan broke ({why}); switched to {by_id[rec_id]['title']}",
                                "alert", code=_broke_code(why))
                elif ap.kept_note != "no-route":
                    havens = ", ".join(h["name"] for h in ps.get("havens_near_origin", [])[:2]) or "none confirmed open"
                    self._entry(ap, "switch", f"Current plan broke ({why}) and no alternative route exists. "
                                              f"Wait somewhere safe (open nearby: {havens}) or use SOS.", "alert",
                                code="switch.noroute")
                    ap.kept_note = "no-route"
            elif rec_id and rec_id != cur["id"]:
                new = by_id[rec_id]
                switch, why, code = self._should_switch(cur, new, ap.user_locked)
                if switch:
                    self._entry(ap, "switch", f"Switched to {new['title']}: {why}", "warn", code=code)
                    ap.kept_note = None
                else:
                    self._keep(ps, cur, new, all_plans)
                    rec_id = cur["id"]
                    if ap.kept_note != new["id"]:
                        lead = "Keeping the way you chose" if ap.user_locked else "Kept current plan"
                        self._entry(ap, "keep", f"{lead}; {why}", code="keep")
                        ap.kept_note = new["id"]

        rec = by_id.get(rec_id) if rec_id else None
        if rec is not None and not initial and ap.prev_rec_id == rec_id:
            self._diff(ap, rec, ps)
        elif rec is not None:
            ap.prev_cats = {c["name"]: c["status"] for c in rec["trust"]["categories"]}
            ap.pending = {}
        if rec is not None:
            self._diff_plan(ap, rec, ps, initial)
            ap.prev_eta = rec["eta"]["expected"]
            ap.prev_feas = dict(rec["feasible"])
            ap.prev_planb = (ps["plan_b"] or {}).get("plan_id")
            ap.prev_rec_id = rec_id
            ap.pinned = specs.get(rec_id)
            ap.history.append({"t": s.now().isoformat(timespec="seconds"), "confidence": rec["trust"]["confidence"],
                               "safety_lo": rec["safety"]["lo"], "safety_hi": rec["safety"]["hi"]})
            ap.history = ap.history[-120:]
        ap.specs = specs
        ps["id"] = ap.id
        ps["user_locked"] = ap.user_locked
        ps["change_log"] = ap.log[-80:]
        ps["history"] = ap.history
        ap.planset = ps
        ap.version += 1
        return ap.log[start_len:]

    def _should_switch(self, cur: dict, new: dict, user_locked: bool = False) -> tuple[bool, str, str]:
        """(switch?, why, code). A way the user chose is only left if it gets late or its data goes bad."""
        cfg = self.state.static.planner_cfg
        H, He = cfg["hysteresis_points"], cfg["hysteresis_eta_s"] / 60
        fr_c, fr_n = _feas_rank(cur), _feas_rank(new)
        case = {3: "worst", 2: "expected", 1: "best"}
        if fr_n > fr_c:
            return (True, f"current plan no longer makes the deadline in the {case.get(fr_n, 'best')} case",
                    "switch.late")
        if fr_n < fr_c:
            return False, f"{new['title']} scores higher but is less likely to make the deadline", "keep"
        rc, rn = STATUS_RANK[cur["trust"]["status"]], STATUS_RANK[new["trust"]["status"]]
        if rc <= STATUS_RANK["OUTDATED"] and rn > rc:
            lim = CATEGORY_LABEL.get(cur["trust"]["limiting"], cur["trust"]["limiting"])
            return True, f"current plan relies on {lim} which is now {cur['trust']['status']}", "switch.data"
        ds = new["safety"]["lo"] - cur["safety"]["lo"]
        dt = _eta_min(cur) - _eta_min(new)
        if user_locked:
            return False, f"{new['title']} differs by {ds:+d} safety / {-dt:+.0f} min", "keep"
        if ds >= H:
            return True, f"worst-case safety +{ds} (threshold {H})", "switch.better"
        if dt >= He and ds >= -2:
            return True, f"{dt:.0f} min faster at similar safety", "switch.better"
        return False, (f"{new['title']} differs by {ds:+d} safety / {-dt:+.0f} min, below the hysteresis "
                       f"threshold ({H} points or {He:.0f} min)"), "keep"

    def choose(self, ap: ActivePlan, plan_id: str) -> bool:
        """The user tapped Start on a way: track that way from now on."""
        spec = ap.specs.get(plan_id)
        if spec is None:
            return False
        ap.pinned, ap.user_locked, ap.kept_note = spec, True, None
        title = next((p["title"] for p in (ap.planset or {}).get("plans", []) if p["id"] == plan_id), plan_id)
        self._entry(ap, "choose", f"User started: {title} (kept unless it breaks, gets late or its data goes bad)",
                    code="choose")
        self.recompute(ap)
        return True

    def _keep(self, ps: dict, cur: dict, new: dict, all_plans: list) -> None:
        """Hysteresis: keep the current plan as the recommendation."""
        if "Recommended" in new["labels"]:
            new["labels"].remove("Recommended")
        if "Recommended" not in cur["labels"]:
            cur["labels"].insert(0, "Recommended")
        if cur not in ps["plans"]:
            ps["plans"].insert(0, cur)
        else:
            ps["plans"].remove(cur)
            ps["plans"].insert(0, cur)
        ps["recommended_id"] = cur["id"]
        if not cur.get("explanation"):
            cur["explanation"] = f"Kept for stability: worst-case safety {cur['safety']['lo']}."
        pb = planner.choose_plan_b(cur, all_plans)
        if pb:
            if pb["plan"] not in ps["plans"]:
                ps["plans"].append(pb["plan"])
            if "Plan B" not in pb["plan"]["labels"]:
                for p in ps["plans"]:
                    if "Plan B" in p["labels"]:
                        p["labels"].remove("Plan B")
                pb["plan"]["labels"].append("Plan B")
            ps["plan_b"] = {k: v for k, v in pb.items() if k != "plan"} | {"plan_id": pb["plan"]["id"]}

    def _diff(self, ap: ActivePlan, rec: dict, ps: dict) -> None:
        """Status transitions of the (unchanged) recommended plan. KNOWN<->PROBABLE flips
        must persist for two ticks before they are logged (one dropped reading is noise)."""
        for c in rec["trust"]["categories"]:
            name, new = c["name"], c["status"]
            old = ap.prev_cats.get(name)
            if old is None:
                ap.prev_cats[name] = new
                continue
            if new == old:
                ap.pending.pop(name, None)
                continue
            serious = new in ("OUTDATED", "UNKNOWN") or old in ("OUTDATED", "UNKNOWN")
            if not serious and ap.pending.get(name) != new:
                ap.pending[name] = new
                continue
            ap.pending.pop(name, None)
            ap.prev_cats[name] = new
            down = STATUS_RANK[new] < STATUS_RANK[old]
            sev = ("alert" if new in ("OUTDATED", "UNKNOWN") else "warn") if down else "info"
            if not c["critical"] and down and sev == "warn":
                sev = "info"
            self._entry(ap, "status", f"{c['label']} {old} -> {new} ({c['detail']})", sev,
                        code=f"status.{name}.{new}", detail=c["detail"], critical=c["critical"])

    def _diff_plan(self, ap: ActivePlan, rec: dict, ps: dict, initial: bool) -> None:
        if initial:
            return
        cfg = self.state.static.planner_cfg
        if ap.prev_eta and rec["eta"]["expected"] and ap.prev_rec_id == rec["id"]:
            d = (datetime.fromisoformat(rec["eta"]["expected"]) - datetime.fromisoformat(ap.prev_eta)).total_seconds()
            if abs(d) >= cfg["eta_change_log_s"]:
                self._entry(ap, "eta", f"Expected arrival {'later' if d > 0 else 'earlier'} by {abs(d) / 60:.0f} min "
                                       f"-> {_eta(rec)}", "warn" if d > 0 else "info",
                            code="eta.later" if d > 0 else "eta.earlier")
        if ap.prev_feas and ap.prev_feas != rec["feasible"] and ps.get("deadline"):
            for case in ("worst", "expected", "best"):
                if ap.prev_feas[case] != rec["feasible"][case]:
                    ok = rec["feasible"][case]
                    self._entry(ap, "feasibility", f"{case.title()} case {'now makes' if ok else 'now misses'} "
                                                   f"the {hhmm(datetime.fromisoformat(ps['deadline']))} deadline",
                                "info" if ok else "alert", code=f"feas.{'make' if ok else 'miss'}.{case}")
                    break
        pb = (ps["plan_b"] or {}).get("plan_id")
        if pb != ap.prev_planb:
            if pb:
                pbp = next((p for p in ps["plans"] if p["id"] == pb), None)
                if pbp:
                    self._entry(ap, "planb", f"Plan B: {pbp['title']} ({ps['plan_b']['reason']})", "info",
                                code="planb.new")
            else:
                self._entry(ap, "planb", "Plan B withdrawn (no independent alternative)", code="planb.none")


def _broke_code(why: str) -> str:
    """Why did the current way break? (for plain-language banners)"""
    w = why.lower()
    if "water" in w or "flood" in w:
        return "switch.flood"
    if "closure" in w:
        return "switch.closure"
    if "cancel" in w or "no catchable trip" in w or "no service" in w:
        return "switch.cancelled"
    return "switch.broke"


def _eta(p: dict) -> str:
    e = p["eta"]
    lo = hhmm(datetime.fromisoformat(e["best"])) if e["best"] else "?"
    hi = hhmm(datetime.fromisoformat(e["worst"])) if e["worst"] else "no worst-case connection"
    return f"{lo}-{hi}"

"""Plain-language view of a plan set for the simple UI (UI_SPEC §4).

The UI must not compute or translate anything technical, so every mapping lives here:
  * safety_level   from the worst-case safety score (thresholds in config.yaml)
  * timing         from deadline vs best / expected / worst arrival
  * warning        only when the weakest *critical* fact is not sure AND it matters
  * safety_reason  from the top real factors, as template fragments (no free text)
  * banner         from the newest plan change in the change log (by machine-readable code)

All words come from the copy deck in frontend/src/copy/{lang}.ts, the same files the
UI uses, so there is one place to translate. The technical plan set stays under
`details` for the Demo drawer.
"""
from __future__ import annotations

import json
import math
import re
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Optional

from ..config import ROOT_DIR
from ..core.planner import choose_plan_b

COPY_DIR = ROOT_DIR / "frontend" / "src" / "copy"
TABS = ("safest", "balanced", "fastest")
STATUS_RANK = {"UNKNOWN": 0, "OUTDATED": 1, "PROBABLE": 2, "KNOWN": 3}
PILL = {"PROBABLE": "label.likely", "OUTDATED": "label.oldInfo", "UNKNOWN": "label.notSure"}
PLACE_TYPE = {"pharmacy": "pharmacy", "hospital": "hospital", "clinic": "hospital", "police": "police",
              "fire_station": "help", "food": "food", "shop": "shop", "fuel": "fuel", "atm": "atm"}
PLACE_ORDER = ["pharmacy", "hospital", "police", "food", "shop", "fuel", "help", "atm"]


# ---- copy -----------------------------------------------------------------------------------------
@lru_cache(maxsize=8)
def load_copy(lang: str) -> dict:
    """Read the JSON object literal inside frontend/src/copy/{lang}.ts (falls back to English)."""
    path = COPY_DIR / f"{lang}.ts"
    try:
        text = path.read_text(encoding="utf-8")
        start = text.index("= {") + 2
        end = text.index("\n}", start)
        table = json.loads(text[start:end + 2])
    except (OSError, ValueError):
        table = {}
    if lang != "en":
        table = {**load_copy("en"), **table}
    return table


@lru_cache(maxsize=1)
def banned() -> dict:
    try:
        return json.loads((COPY_DIR / "banned.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"banned": []}


def banned_hits(text: str) -> list[str]:
    low = (text or "").lower()
    return [w for w in banned()["banned"] if re.search(rf"(^|[^a-z]){re.escape(w)}([^a-z]|$)", low)]


class T:
    def __init__(self, lang: str = "en"):
        self.lang = lang if lang in ("en", "hi") else "en"
        self.table = load_copy(self.lang)

    def __call__(self, key: str, **params) -> str:
        s = self.table.get(key, key)
        for k, v in params.items():
            s = s.replace("{" + k + "}", str(v))
        return s


# ---- small formatters -----------------------------------------------------------------------------
def clock(iso: Optional[str]) -> Optional[str]:
    """'2026-10-26T02:58:12+05:30' -> '2:58' (night times are read without am/pm)."""
    if not iso:
        return None
    dt = datetime.fromisoformat(iso)
    h = dt.hour % 12 or 12
    return f"{h}:{dt.minute:02d}"


def dist_text(m: float, t: T) -> str:
    if m < 1000:
        return t("fmt.meters", n=max(10, int(round(m / 10.0)) * 10))
    return t("fmt.km", n=f"{m / 1000:.1f}")


def short_place(name: Optional[str]) -> str:
    """'Sitabuldi Police Station (Nagpur)' -> 'Sitabuldi Police Station'; keeps lines short."""
    if not name:
        return ""
    n = re.split(r"\s*[(,]", name)[0].strip()
    return n if len(n) <= 26 else n[:25].rstrip() + "…"


def place_state(open_view: dict) -> Optional[str]:
    """Open-state facts -> the three words of UI_SPEC: open / maybe_open / not_sure (closed -> None)."""
    st, val = open_view.get("status"), open_view.get("value")
    if val is False and st in ("KNOWN", "PROBABLE"):
        return None
    if st == "KNOWN" and val is True:
        return "open"
    if st == "PROBABLE" and val is True:
        return "maybe_open"
    return "not_sure"


STATE_KEY = {"open": "label.open", "maybe_open": "label.maybeOpen", "not_sure": "label.notSure"}


# ---- the mapping ----------------------------------------------------------------------------------
class SimpleView:
    def __init__(self, planset: dict, *, lang: str, now: datetime, cfg: dict, connection: str = "live",
                 dest: Optional[dict] = None, chosen_plan_id: Optional[str] = None):
        self.ps = planset
        self.t = T(lang)
        self.now = now
        self.pcfg = cfg.get("presentation", {})
        self.connection = connection
        self.dest = dest or {}
        self.chosen = chosen_plan_id
        self.plans = planset.get("plans", [])
        self.by_id = {p["id"]: p for p in self.plans}
        self.deadline = planset.get("deadline")

    # -- top level --
    def build(self) -> dict:
        t = self.t
        tabs = self._pick_tabs()
        options, plan_to_opt = [], {}
        for tab in TABS:
            p = tabs.get(tab)
            if p is None:
                continue
            opt = self.option(p)
            opt.update({"id": tab, "label": t(f"label.{tab}"), "tab": True,
                        "same_as": plan_to_opt.get(p["id"])})
            if opt["same_as"]:
                opt["same_text"] = t("line.sameWay", tab=t(f"label.{opt['same_as']}"))
            plan_to_opt.setdefault(p["id"], tab)
            options.append(opt)
        extra = []
        for opt in options:
            bid = opt.pop("_backup_plan_id", None)
            if bid is None:
                continue
            if bid not in plan_to_opt:
                b = self.option(self.by_id[bid])
                b.pop("_backup_plan_id", None)
                b.update({"id": f"backup-{bid}", "label": t("label.backup"), "tab": False, "same_as": None})
                plan_to_opt[bid] = b["id"]
                extra.append(b)
            if opt["warning"] is not None:
                opt["warning"]["backup_option_id"] = plan_to_opt[bid]
            opt["backup_option_id"] = plan_to_opt[bid]
        for b in extra:
            b.pop("_backup_plan_id", None)
        options += extra
        cur_plan = self.chosen if self.chosen in self.by_id else self.ps.get("recommended_id")
        current = plan_to_opt.get(cur_plan)
        if cur_plan and current is None and cur_plan in self.by_id:
            c = self.option(self.by_id[cur_plan])
            c.pop("_backup_plan_id", None)
            c.update({"id": f"current-{cur_plan}", "label": t("label.backup"), "tab": False, "same_as": None})
            options.append(c)
            current = c["id"]
        cur_opt = next((o for o in options if o["id"] == current), None)
        return {
            "id": self.ps.get("id"), "lang": t.lang, "phase": self.ps.get("phase"),
            "now_text": clock(self.now.isoformat()), "connection": self.connection,
            "options": options, "current_option_id": current,
            "banner": self.banner(current),
            "trip": self.trip(cur_opt, self.by_id.get(cur_plan)) if cur_opt else None,
            "deadline_text": clock(self.deadline),
            "error_text": None if options else t("line.noWay"),
        }

    def _pick_tabs(self) -> dict:
        lab = {}
        for p in self.plans:
            for label in p["labels"]:
                lab.setdefault(label, p)
        rec = self.by_id.get(self.ps.get("recommended_id"))
        safest = lab.get("Safest") or rec or (self.plans[0] if self.plans else None)
        if safest is None:
            return {}
        fastest = lab.get("Fastest") or safest
        balanced = lab.get("Balanced")
        if balanced is None:
            balanced = rec if rec is not None and rec not in (safest, fastest) else safest
        return {"safest": safest, "balanced": balanced, "fastest": fastest}

    # -- one option --
    def option(self, p: dict) -> dict:
        t = self.t
        timing = self.timing(p)
        level = self.level(p)
        warning, backup = self.warning(p, timing)
        opt = {
            "plan_id": p["id"], "kind": p["kind"],
            "arrive_text": self.arrive_text(p), "arrive_time": clock(p["eta"]["expected"]),
            "timing": timing,
            "timing_text": {"on_time": t("label.onTime"), "maybe_late": t("label.couldBeLate"),
                            "too_late": t("label.tooLate")}.get(timing),
            "late_text": t("fmt.maybe", time=clock(p["eta"]["worst"])) if timing == "maybe_late" and p["eta"]["worst"] else None,
            "safety_level": level,
            "safety_text": t({"safe": "label.safe", "ok": "label.ok", "careful": "label.careful"}[level]),
            "safety_reason": self.reason(p, level),
            "steps": self.steps(p),
            "warning": warning,
            "places": self.places(p),
            "path": self.path(p),
            "_backup_plan_id": backup,
        }
        if timing == "too_late" and backup is None:
            alt = choose_plan_b(p, self.plans)
            opt["_backup_plan_id"] = alt["plan"]["id"] if alt else None
        pts = opt["path"]
        opt["start"] = pts[0] if pts else None
        opt["end"] = pts[-1] if pts else None
        return opt

    def arrive_text(self, p: dict) -> str:
        time = clock(p["eta"]["expected"]) or "?"
        kind = self.dest.get("kind")
        if kind == "home":
            return self.t("fmt.homeBy", time=time)
        if kind == "work":
            return self.t("fmt.workBy", time=time)
        return self.t("fmt.placeBy", place=short_place(self.dest.get("name")) or "?", time=time)

    def timing(self, p: dict) -> str:
        if not self.deadline:
            return "none"
        f = p["feasible"]
        if f["worst"]:
            return "on_time"
        if f["best"] or f["expected"]:
            return "maybe_late"
        return "too_late"

    def level(self, p: dict) -> str:
        lo = p["safety"]["lo"]
        if lo >= self.pcfg.get("safe_min", 75):
            return "safe"
        if lo >= self.pcfg.get("ok_min", 50):
            return "ok"
        return "careful"

    # -- why safe / not safe: top real factors, as template fragments --
    def factors(self, p: dict) -> tuple[list[tuple[str, float]], list[tuple[str, float]]]:
        r = {k: (v["lo"] + v["hi"]) / 2 for k, v in p["risk"].items()}
        cats = {c["name"]: c for c in p["trust"]["categories"]}
        total = p["duration_min"]["expected"] or 1.0
        outdoor_share = min(1.0, p["outdoor_min"] / total)
        pos, neg = [], []
        if p["kind"] == "cab":
            pos.append(("reason.inVehicle", max(0.45, 1.0 - outdoor_share)))   # door to door
        elif p["kind"] in ("bus", "metro") and outdoor_share < 0.5:
            pos.append(("reason.inVehicle", 1.0 - outdoor_share))
        light = cats.get("lighting")
        if light and p["walk_m"] >= 150:
            if light["status"] == "KNOWN" and r["lighting"] <= 0.35:
                pos.append(("reason.lit", 0.9 - r["lighting"]))          # mapped as lit, not guessed
            elif light["status"] == "PROBABLE":
                pos.append(("reason.mainRoads", 0.55))
            if r["lighting"] >= 0.45 and light["status"] in ("UNKNOWN", "KNOWN"):
                neg.append(("reason.dark", r["lighting"]))
        cats_open = {o["cat"] for o in p.get("open_along", [])}
        if cats_open & {"shop", "food", "pharmacy", "fuel"}:
            pos.append(("reason.shopsOpen", 0.7))
        if r["emergency"] <= 0.15 or cats_open & {"hospital", "police"}:
            pos.append(("reason.helpNear", 0.5))
        elif r["emergency"] >= 0.6:
            neg.append(("reason.helpFar", r["emergency"]))
        if 0 < p["walk_m"] <= 400 and p["kind"] in ("walk", "bus", "metro"):
            pos.append(("reason.shortWalk", 0.4))
        if p["walk_m"] >= 2000:
            neg.append(("reason.longWalk", min(1.0, p["walk_m"] / 4000)))
        if r["incident"] >= 0.4:
            neg.append(("reason.incidents", r["incident"]))
        if r["isolation"] >= 0.45:
            neg.append(("reason.quiet", r["isolation"]))
        if r["weather"] >= 0.3 and cats.get("weather", {}).get("status") != "UNKNOWN":
            neg.append(("reason.rain", r["weather"]))
        if p["kind"] == "walk" and r["traffic"] >= 0.3:
            neg.append(("reason.traffic", r["traffic"]))
        pos.sort(key=lambda f: -f[1])
        neg.sort(key=lambda f: -f[1])
        return pos, neg

    def reason(self, p: dict, level: str) -> str:
        pos, neg = self.factors(p)
        if level == "safe":
            picked = pos[:2] or neg[:1]
        elif level == "careful":
            picked = neg[:2] or pos[:1]
        else:
            picked = (pos[:1] + neg[:1]) or pos[:2] or neg[:2]
        frags = [self.t(k) for k, _ in picked[:2]]
        if not frags:
            return self.t("line.reasonDefault")
        text = self.t("fmt.reasonTwo", a=frags[0], b=frags[1]) if len(frags) == 2 else self.t("fmt.reasonOne", a=frags[0])
        return text[:1].upper() + text[1:]

    # -- the one "not sure" line --
    def warning(self, p: dict, timing: str) -> tuple[Optional[dict], Optional[str]]:
        t = self.t
        crit = [c for c in p["trust"]["categories"] if c["critical"]]
        weak = min(crit, key=lambda c: (STATUS_RANK[c["status"]], c["confidence"])) if crit else None
        key, st = None, None
        if weak is not None and weak["status"] in ("OUTDATED", "UNKNOWN"):
            st = weak["status"]
            key = {"transit_timing": "line.busGuess", "cab_availability": "line.cabGuess",
                   "traffic": "line.trafficOld" if st == "OUTDATED" else "line.trafficNotSure",
                   "closures": "line.roadsOld" if st == "OUTDATED" else "line.roadsNotSure",
                   "weather": "line.weatherNotSure"}.get(weak["name"])
        elif weak is not None and weak["status"] == "PROBABLE":
            # Probable is normal for timetables and cab apps; it only matters when we lost live
            # bus info, or when the guess could make you late.
            if weak["name"] == "transit_timing" and "timetable" in weak["detail"]:
                key, st = "line.busGuess", "PROBABLE"
            elif weak["name"] == "cab_availability" and timing in ("maybe_late", "too_late"):
                key, st = "line.cabGuess", "PROBABLE"
        if key is None and p["kind"] == "walk" and timing in ("maybe_late", "too_late") and self._bus_missing():
            cab = next((q for q in self.plans if q["kind"] == "cab"), None)
            if cab is not None:
                return {"text": t("line.noBusTryCab"), "pill": None, "backup_option_id": None}, cab["id"]
        light = next((c for c in p["trust"]["categories"] if c["name"] == "lighting"), None)
        if key is None and light and light["status"] == "UNKNOWN" and p["walk_m"] >= 300:
            key, st = "line.lightsNotSure", "UNKNOWN"
        if key is None:
            return None, None
        alt = choose_plan_b(p, self.plans)
        return ({"text": t(key), "pill": t(PILL[st]) if st in PILL else None, "backup_option_id": None},
                alt["plan"]["id"] if alt else None)

    def _bus_missing(self) -> bool:
        return any(("no service" in n or "no catchable" in n) for n in self.ps.get("notes", []))

    # -- steps, places, path --
    def _to_name(self, name: str) -> str:
        if name and self.dest.get("name") and name == self.dest.get("name"):
            if self.dest.get("kind") == "home":
                return self.t("label.home")
            if self.dest.get("kind") == "work":
                return self.t("label.work")
        return short_place(name)

    def steps(self, p: dict) -> list[dict]:
        t, out = self.t, []
        for s in p["segments"]:
            d = s["duration_s"]["expected"] or 0
            mins = max(1, int(round(d / 60)))
            to = self._to_name(s.get("to", ""))
            if s["mode"] == "walk":
                out.append({"icon": "walk", "minutes": mins, "text": t("fmt.walkTo", dist=dist_text(s["distance_m"], t), place=to)})
            elif s["mode"] == "wait":
                if s.get("cab"):
                    text = t("fmt.waitCab")
                elif s.get("haven"):
                    text = t("fmt.waitInside", place=short_place(s["haven"]))
                else:
                    text = t("fmt.waitBus", line=s.get("route_id", ""))
                out.append({"icon": "wait", "minutes": mins, "text": text})
            elif s["mode"] in ("bus", "metro"):
                key = "fmt.busTo" if s["mode"] == "bus" else "fmt.metroTo"
                out.append({"icon": s["mode"], "line": s.get("route_id"), "minutes": mins,
                            "text": t(key, line=s.get("route_id", ""), place=to)})
            elif s["mode"] == "cab":
                out.append({"icon": "cab", "minutes": mins, "text": t("fmt.cabTo", place=to)})
        return out

    def places(self, p: dict) -> list[dict]:
        t, seen, out = self.t, set(), []
        pool = list(p.get("open_along", [])) + list(p.get("safe_havens", [])) + list(self.ps.get("havens_near_origin", []))
        for poi in pool:
            if poi["id"] in seen:
                continue
            seen.add(poi["id"])
            state = place_state(poi["open"])
            if state is None:
                continue
            typ = PLACE_TYPE.get(poi["cat"], "help")
            d = poi.get("dist_m") or 0
            out.append({"id": poi["id"], "type": typ, "name": short_place(poi["name"]), "distance_m": int(d),
                        "distance_text": dist_text(d, t), "state": state, "state_text": t(STATE_KEY[state]),
                        "lat": poi["lat"], "lon": poi["lon"]})
        out.sort(key=lambda x: (PLACE_ORDER.index(x["type"]) if x["type"] in PLACE_ORDER else 99, x["distance_m"]))
        return out[:6]

    @staticmethod
    def path(p: dict) -> list[list[float]]:
        pts: list[list[float]] = []
        for s in p["segments"]:
            for lon, lat in s["geometry"]:
                q = [round(lat, 6), round(lon, 6)]
                if not pts or pts[-1] != q:
                    pts.append(q)
        return pts

    # -- live trip state for the "Go" screen --
    def trip(self, opt: dict, p: Optional[dict]) -> Optional[dict]:
        if p is None:
            return None
        dep = datetime.fromisoformat(self.ps["departure"])
        eta = datetime.fromisoformat(p["eta"]["expected"]) if p["eta"]["expected"] else dep
        now = self.now
        idx = 0
        for i, s in enumerate(p["segments"]):
            st, en = s["start"]["expected"], s["end"]["expected"]
            if st and en and datetime.fromisoformat(st) <= now < datetime.fromisoformat(en):
                idx = i
                break
            if en and now >= datetime.fromisoformat(en):
                idx = min(i + 1, len(p["segments"]) - 1)
        span = max(1.0, (eta - dep).total_seconds())
        progress = 0.0 if now <= dep else min(1.0, (now - dep).total_seconds() / span)
        arrived = now >= eta
        steps = opt["steps"]
        return {
            "option_id": opt["id"], "step_index": idx, "progress": round(progress, 3), "arrived": arrived,
            "next_text": self.t("line.arrived") if arrived else (steps[idx]["text"] if steps else ""),
            "next_icon": "done" if arrived else (steps[idx]["icon"] if steps else "walk"),
            "minutes_left": max(0, int(math.ceil((eta - now).total_seconds() / 60))),
            "position": _along(opt["path"], progress),
        }

    # -- one plain sentence for the newest plan change --
    def banner(self, current_option_id: Optional[str]) -> Optional[dict]:
        """Only for a trip the user started: before Start, the options simply update quietly."""
        if not self.ps.get("user_locked"):
            return None
        max_age = timedelta(seconds=self.pcfg.get("banner_max_age_s", 600))
        for e in reversed(self.ps.get("change_log", [])):
            key = banner_key(e.get("code", ""))
            if key is None:
                continue
            if self.now - datetime.fromisoformat(e["t"]) > max_age:
                return None
            return {"id": f"{e['t']}#{e['code']}", "text": self.t(key), "see_option_id": current_option_id}
        return None


def banner_key(code: str) -> Optional[str]:
    """Only real plan changes become banners (UI_SPEC: calm, one banner at a time)."""
    return {
        "switch.closure": "line.roadClosedNewWay", "switch.flood": "line.waterNewWay",
        "switch.cancelled": "line.busCancelledNewWay", "switch.late": "line.lateNewWay",
        "switch.data": "line.infoOldNewWay", "switch.better": "line.betterWay",
        "switch.broke": "line.betterWay", "switch.noroute": "line.stuck",
    }.get(code) or ("line.mayBeLate" if code.startswith("feas.miss") else None)


def _along(path: list, frac: float) -> Optional[list]:
    """Point at fraction `frac` of the path length (expected position, no GPS)."""
    if not path:
        return None
    if frac <= 0 or len(path) == 1:
        return path[0]
    seg = [math.dist(a, b) for a, b in zip(path, path[1:])]
    target, acc = sum(seg) * min(frac, 1.0), 0.0
    for (a, b), L in zip(zip(path, path[1:]), seg):
        if acc + L >= target and L > 0:
            k = (target - acc) / L
            return [round(a[0] + (b[0] - a[0]) * k, 6), round(a[1] + (b[1] - a[1]) * k, 6)]
        acc += L
    return path[-1]


def user_texts(view: dict) -> list[str]:
    """Every sentence a normal user can see in a simple view (place names and `details` excluded)."""
    out = []
    for o in view.get("options", []):
        out += [o[k] for k in ("label", "arrive_text", "timing_text", "late_text", "safety_text", "safety_reason",
                               "same_text") if o.get(k)]
        out += [s["text"] for s in o["steps"]]
        if o["warning"]:
            out += [o["warning"]["text"], o["warning"]["pill"] or ""]
        out += [p["state_text"] for p in o["places"]]
    if view.get("banner"):
        out.append(view["banner"]["text"])
    if view.get("trip"):
        out.append(view["trip"]["next_text"])
    if view.get("error_text"):
        out.append(view["error_text"])
    return [s for s in out if s]


def plain_violations(view: dict, max_words: int = 12) -> list[str]:
    """Banned words or over-long sentences in a simple view (UI_SPEC §3)."""
    bad = []
    for s in user_texts(view):
        hits = banned_hits(s)
        if hits:
            bad.append(f"banned {hits} in '{s}'")
        if len(s.replace(",", " ").split()) > max_words:
            bad.append(f"too long: '{s}'")
    return bad


def connection_state(state) -> str:
    """'offline' when no live information is coming in (all live sources off or too old)."""
    live = [s for s in state.sources.values() if s.live]
    ok = [s for s in live if s.enabled and state.source_view(s.id).status in ("KNOWN", "PROBABLE")]
    return "live" if ok else "offline"


def present(planset: dict, *, lang: str, now: datetime, cfg: dict, connection: str,
            dest: Optional[dict] = None, chosen_plan_id: Optional[str] = None) -> dict:
    view = SimpleView(planset, lang=lang, now=now, cfg=cfg, connection=connection, dest=dest,
                      chosen_plan_id=chosen_plan_id).build()
    view["details"] = planset
    return view


def simple_places(results: list[dict], lang: str) -> list[dict]:
    """Need-now / help results -> name, distance, walking minutes, Open / Maybe open / Not sure."""
    t, out = T(lang), []
    for r in results:
        state = place_state(r["open"])
        if state is None:
            continue
        out.append({"id": r["id"], "type": PLACE_TYPE.get(r["cat"], "help"), "name": short_place(r["name"]),
                    "distance_m": r["distance_m"], "distance_text": dist_text(r["distance_m"], t),
                    "minutes": int(round(r["minutes"]["expected"])),
                    "minutes_text": t("fmt.walkMin", n=int(round(r["minutes"]["expected"]))),
                    "state": state, "state_text": t(STATE_KEY[state]), "lat": r["lat"], "lon": r["lon"],
                    "path": [[round(lat, 6), round(lon, 6)] for lon, lat in r["geometry"]]})
    return out

// Simple view (spec §7.4): the ONLY thing the UI renders. All mapping from technical plans to
// plain words lives here, and every word comes from src/copy (en / hi):
//   safety_level  from the worst-case score (thresholds in config)
//   timing        from the deadline vs best / expected / worst arrival
//   warning       only when the weakest CRITICAL fact is not sure AND it matters
//   safety_reason template fragments from the top real factors (no free text)
//   banner        the newest plan change, as one plain sentence (only during a started trip)
import { CONFIG } from "../config";
import banned from "../copy/banned.json";
import { format, type CopyKey, type Lang } from "../copy/format";
import { RANK, type FactView, type Status } from "./freshness";
import type { NeedResult } from "./needs";
import { choosePlanB, type Plan, type PlanSet } from "./planner";
import type { PoiView } from "./services";
import type { CityTime } from "./time";

export type LatLon = [number, number];
export interface Step { icon: "walk" | "wait" | "bus" | "metro"; minutes: number; text: string; line?: string }
export interface PlaceOnWay { id: string; type: string; name: string; distance_m: number; distance_text: string; state: "open" | "maybe_open" | "not_sure"; state_text: string; lat: number; lon: number; minutes?: number; minutes_text?: string; path?: LatLon[]; phone?: string | null }
export interface Option {
  id: string; label: string; tab: boolean; plan_id: string; kind: string; same_as: string | null; same_text?: string;
  arrive_text: string; arrive_time: string | null; timing: "on_time" | "maybe_late" | "too_late" | "none"; timing_text: string | null; late_text: string | null;
  safety_level: "safe" | "ok" | "careful"; safety_text: string; safety_reason: string; steps: Step[];
  warning: { text: string; pill: string | null; backup_option_id: string | null; safe_wait?: boolean } | null; backup_option_id?: string | null;
  places: PlaceOnWay[]; path: LatLon[]; start: LatLon | null; end: LatLon | null; changes: LatLon[];
}
export interface TripState { option_id: string; step_index: number; progress: number; arrived: boolean; next_text: string; next_icon: string; minutes_left: number; position: LatLon | null }
export interface SimpleView {
  id: string; lang: Lang; phase: string; now_text: string; connection: "live" | "offline";
  options: Option[]; current_option_id: string | null; banner: { id: string; text: string; see_option_id: string | null } | null;
  trip: TripState | null; deadline_text: string | null; error_text: string | null; details: PlanSet;
}

const TABS = ["safest", "balanced", "fastest"] as const;
const PILL: Partial<Record<Status, CopyKey>> = { PROBABLE: "label.likely", OUTDATED: "label.oldInfo", UNKNOWN: "label.notSure" };
const PLACE_TYPE: Record<string, string> = { pharmacy: "pharmacy", hospital: "hospital", clinic: "hospital", police: "police", fire_station: "help", food: "food", shop: "shop", fuel: "fuel", atm: "atm" };
const PLACE_ORDER = ["pharmacy", "hospital", "police", "food", "shop", "fuel", "help", "atm"];
const STATE_KEY: Record<string, CopyKey> = { open: "label.open", maybe_open: "label.maybeOpen", not_sure: "label.notSure" };

export function placeState(v: Pick<FactView, "status" | "value">): "open" | "maybe_open" | "not_sure" | null {
  if (v.value === false && (v.status === "KNOWN" || v.status === "PROBABLE")) return null;
  if (v.status === "KNOWN" && v.value === true) return "open";
  if (v.status === "PROBABLE" && v.value === true) return "maybe_open";
  return "not_sure";
}

export function shortPlace(name: string | null | undefined): string {
  if (!name) return "";
  const n = name.split(/\s*[(,]/)[0].trim();
  return n.length <= 26 ? n : `${n.slice(0, 25).trimEnd()}…`;
}

export function bannerKey(code: string): CopyKey | null {
  const m: Record<string, CopyKey> = {
    "switch.closure": "line.roadClosedNewWay", "switch.flood": "line.waterNewWay", "switch.cancelled": "line.busCancelledNewWay",
    "switch.late": "line.lateNewWay", "switch.data": "line.infoOldNewWay", "switch.better": "line.betterWay", "switch.broke": "line.betterWay",
    "switch.noroute": "line.stuck",
  };
  return m[code] ?? (code.startsWith("feas.miss") ? "line.mayBeLate" : null);
}

export interface Dest { name?: string; kind?: "home" | "work" | null }

export class SimpleViewBuilder {
  private t: (k: CopyKey, p?: Record<string, string | number>) => string;
  private plans: Plan[];
  private byId: Map<string, Plan>;
  constructor(private ps: PlanSet, private lang: Lang, private now: number, private city: CityTime, private connection: "live" | "offline", private dest: Dest = {}) {
    this.t = (k, p) => format(lang, k, p);
    this.plans = ps.plans;
    this.byId = new Map(ps.plans.map((p) => [p.id, p]));
  }

  dist(m: number): string {
    return m < 1000 ? this.t("fmt.meters", { n: Math.max(10, Math.round(m / 10) * 10) }) : this.t("fmt.km", { n: (m / 1000).toFixed(1) });
  }

  build(): SimpleView {
    const t = this.t;
    const tabs = this.pickTabs();
    const options: Option[] = [];
    const planToOpt = new Map<string, string>();
    const backupOf = new Map<string, string | null>();
    for (const tab of TABS) {
      const p = tabs[tab];
      if (!p) continue;
      const [o, b] = this.option(p);
      const same = planToOpt.get(p.id) ?? null;
      Object.assign(o, { id: tab, label: t(`label.${tab}` as CopyKey), tab: true, same_as: same });
      if (same) o.same_text = t("line.sameWay", { tab: t(`label.${same}` as CopyKey) });
      if (!planToOpt.has(p.id)) planToOpt.set(p.id, tab);
      backupOf.set(tab, b);
      options.push(o);
    }
    const extra: Option[] = [];
    for (const o of options) {
      const bid = backupOf.get(o.id);
      if (!bid) continue;
      if (!planToOpt.has(bid)) {
        const [b] = this.option(this.byId.get(bid)!);
        Object.assign(b, { id: `backup-${bid}`, label: t("label.backup"), tab: false, same_as: null });
        planToOpt.set(bid, b.id);
        extra.push(b);
      }
      if (o.warning) o.warning.backup_option_id = planToOpt.get(bid)!;
      o.backup_option_id = planToOpt.get(bid)!;
    }
    options.push(...extra);
    const curPlan = this.ps.recommendedId;
    let current = curPlan ? planToOpt.get(curPlan) ?? null : null;
    if (curPlan && !current && this.byId.has(curPlan)) {
      const [c] = this.option(this.byId.get(curPlan)!);
      Object.assign(c, { id: `current-${curPlan}`, label: t("label.backup"), tab: false, same_as: null });
      options.push(c);
      current = c.id;
    }
    const curOpt = options.find((o) => o.id === current) ?? null;
    return {
      id: this.ps.id ?? "", lang: this.lang, phase: this.ps.phase, now_text: this.city.clock(this.now)!, connection: this.connection,
      options, current_option_id: current, banner: this.banner(current),
      trip: curOpt && curPlan ? this.trip(curOpt, this.byId.get(curPlan)!) : null,
      deadline_text: this.city.clock(this.ps.deadline), error_text: options.length ? null : t("line.noWay"), details: this.ps,
    };
  }

  private pickTabs(): Record<(typeof TABS)[number], Plan | undefined> {
    const lab = new Map<string, Plan>();
    for (const p of this.plans) for (const l of p.labels) if (!lab.has(l)) lab.set(l, p);
    const rec = this.ps.recommendedId ? this.byId.get(this.ps.recommendedId) : undefined;
    const safest = lab.get("Safest") ?? rec ?? this.plans[0];
    if (!safest) return { safest: undefined, balanced: undefined, fastest: undefined };
    const fastest = lab.get("Fastest") ?? safest;
    const balanced = lab.get("Balanced") ?? (rec && rec !== safest && rec !== fastest ? rec : safest);
    return { safest, balanced, fastest };
  }

  private option(p: Plan): [Option, string | null] {
    const t = this.t;
    const timing = this.timing(p);
    const level = p.safety.lo >= CONFIG.presentation.safeMin ? "safe" : p.safety.lo >= CONFIG.presentation.okMin ? "ok" : "careful";
    const [warning, backup0] = this.warning(p, timing);
    let backup = backup0;
    if (timing === "too_late" && !backup) backup = choosePlanB(p, this.plans)?.plan.id ?? null;
    const path = this.path(p);
    return [{
      id: "", label: "", tab: false, same_as: null, plan_id: p.id, kind: p.kind,
      arrive_text: this.arrive(p), arrive_time: this.city.clock(p.eta.expected), timing,
      timing_text: ({ on_time: t("label.onTime"), maybe_late: t("label.couldBeLate"), too_late: t("label.tooLate") } as Record<string, string>)[timing] ?? null,
      late_text: timing === "maybe_late" && p.eta.worst ? t("fmt.maybe", { time: this.city.clock(p.eta.worst)! }) : null,
      safety_level: level, safety_text: t(level === "safe" ? "label.safe" : level === "ok" ? "label.ok" : "label.careful"),
      safety_reason: this.reason(p, level), steps: this.steps(p), warning, places: this.places(p), changes: p.segments.filter((x) => x.mode === "wait" && x.change).map((x) => x.coords[0]), path,
      start: path[0] ?? null, end: path[path.length - 1] ?? null,
    }, backup];
  }

  private arrive(p: Plan): string {
    const time = this.city.clock(p.eta.expected) ?? "?";
    if (this.dest.kind === "home") return this.t("fmt.homeBy", { time });
    if (this.dest.kind === "work") return this.t("fmt.workBy", { time });
    return this.t("fmt.placeBy", { place: shortPlace(this.dest.name) || "?", time });
  }

  private timing(p: Plan): Option["timing"] {
    if (this.ps.deadline === null) return "none";
    if (p.feasible.worst) return "on_time";
    if (p.feasible.best || p.feasible.expected) return "maybe_late";
    return "too_late";
  }

  /** Top real factors -> template fragments. Never claims lit roads unless they are mapped as lit. */
  private factors(p: Plan): [[CopyKey, number][], [CopyKey, number][]] {
    const r = Object.fromEntries(Object.entries(p.risk).map(([k, v]) => [k, (v.lo + v.hi) / 2])) as Record<string, number>;
    const cats = new Map(p.trust.categories.map((c) => [c.name, c]));
    const outdoor = Math.min(1, p.outdoorMin / (p.durationMin.expected || 1));
    const pos: [CopyKey, number][] = [], neg: [CopyKey, number][] = [];
    if ((p.kind === "bus" || p.kind === "metro") && outdoor < 0.5) pos.push(["reason.inVehicle", 1 - outdoor]);
    const light = cats.get("lighting");
    if (light && p.walkM >= 150) {
      if (light.status === "KNOWN" && r.lighting <= 0.35) pos.push(["reason.lit", 0.9 - r.lighting]);
      else if (light.status === "PROBABLE") pos.push(["reason.mainRoads", 0.55]);
      if (r.lighting >= 0.45 && (light.status === "UNKNOWN" || light.status === "KNOWN")) neg.push(["reason.dark", r.lighting]);
    }
    const open = new Set(p.openAlong.map((o) => o.type));
    if (["shop", "food", "pharmacy", "fuel"].some((x) => open.has(x))) pos.push(["reason.shopsOpen", 0.7]);
    if (r.emergency <= 0.15 || open.has("hospital") || open.has("police")) pos.push(["reason.helpNear", 0.5]);
    else if (r.emergency >= 0.6) neg.push(["reason.helpFar", r.emergency]);
    if (p.walkM > 0 && p.walkM <= 400) pos.push(["reason.shortWalk", 0.4]);
    if (p.walkM >= 2000) neg.push(["reason.longWalk", Math.min(1, p.walkM / 4000)]);
    if (r.incident >= 0.4) neg.push(["reason.incidents", r.incident]);
    if (r.isolation >= 0.45) neg.push(["reason.quiet", r.isolation]);
    if (r.weather >= 0.3 && cats.get("weather")?.status !== "UNKNOWN") neg.push(["reason.rain", r.weather]);
    if (p.kind === "walk" && r.traffic >= 0.3) neg.push(["reason.traffic", r.traffic]);
    pos.sort((a, b) => b[1] - a[1]); neg.sort((a, b) => b[1] - a[1]);
    return [pos, neg];
  }

  private reason(p: Plan, level: string): string {
    const [pos, neg] = this.factors(p);
    const picked = level === "safe" ? (pos.length ? pos.slice(0, 2) : neg.slice(0, 1)) : level === "careful" ? (neg.length ? neg.slice(0, 2) : pos.slice(0, 1))
      : [...pos.slice(0, 1), ...neg.slice(0, 1)].length ? [...pos.slice(0, 1), ...neg.slice(0, 1)] : [...pos, ...neg].slice(0, 2);
    const frags = picked.slice(0, 2).map(([k]) => this.t(k));
    if (!frags.length) return this.t("line.reasonDefault");
    const s = frags.length === 2 ? this.t("fmt.reasonTwo", { a: frags[0], b: frags[1] }) : this.t("fmt.reasonOne", { a: frags[0] });
    return s[0].toUpperCase() + s.slice(1);
  }

  /** The one "not sure" line: only when the weakest critical fact is not sure AND it matters. */
  private warning(p: Plan, timing: Option["timing"]): [Option["warning"], string | null] {
    const crit = p.trust.categories.filter((c) => c.critical);
    const weak = crit.length ? crit.reduce((a, b) => (RANK[b.status] < RANK[a.status] || (b.status === a.status && b.confidence < a.confidence) ? b : a)) : null;
    let key: CopyKey | null = null, st: Status | null = null;
    if (weak && (weak.status === "OUTDATED" || weak.status === "UNKNOWN")) {
      st = weak.status;
      const m: Record<string, CopyKey> = { transit_timing: weak.detail.includes("hours not known") ? "line.busHoursNotSure" : "line.busGuess",
        traffic: st === "OUTDATED" ? "line.trafficOld" : "line.trafficNotSure",
        closures: st === "OUTDATED" ? "line.roadsOld" : "line.roadsNotSure", weather: "line.weatherNotSure" };
      key = m[weak.name] ?? null;
    } else if (weak?.status === "PROBABLE") {
      // PROBABLE is normal for a timetable; it matters when live bus info is lost
      if (weak.name === "transit_timing" && weak.detail.includes("timetable")) { key = "line.busGuess"; st = "PROBABLE"; }
    }
    void timing;
    const light = p.trust.categories.find((c) => c.name === "lighting");
    if (!key && light?.status === "UNKNOWN" && p.walkM >= 300) { key = "line.lightsNotSure"; st = "UNKNOWN"; }
    if (!key) return [null, null];
    const alt = choosePlanB(p, this.plans);
    // no other way: the Backup is waiting somewhere safe (UPGRADE §5.1), never a made-up option
    return [{ text: this.t(key), pill: st && PILL[st] ? this.t(PILL[st]!) : null, backup_option_id: null, safe_wait: !alt }, alt?.plan.id ?? null];
  }

  private toName(name: string): string {
    if (name && this.dest.name && name === this.dest.name) {
      if (this.dest.kind === "home") return this.t("label.home");
      if (this.dest.kind === "work") return this.t("label.work");
    }
    return shortPlace(name);
  }

  private steps(p: Plan): Step[] {
    const t = this.t;
    // a few metres on foot between two rides (same stand) is part of the change, not a step of its own
    const segs = p.segments.filter((s, i) => !(s.mode === "walk" && s.distanceM < 30 && i > 0 && i < p.segments.length - 1));
    return segs.map((s) => {
      const minutes = Math.max(1, Math.round((s.durationS.expected ?? 0) / 60));
      const to = this.toName(s.to);
      if (s.mode === "walk") return { icon: "walk", minutes, text: t("fmt.walkTo", { dist: this.dist(s.distanceM), place: to }) } as Step;
      if (s.mode === "wait") return { icon: "wait", minutes, text: s.haven ? t("fmt.waitInside", { place: shortPlace(s.haven) })
        : s.change ? t("fmt.changeWait", { n: minutes }) : t("fmt.waitBus", { line: s.routeId ?? "" }) } as Step;
      return { icon: s.mode, line: s.routeId, minutes, text: s.mode === "bus" ? t("fmt.busTo", { line: s.routeId ?? "", place: to }) : t("fmt.metroTo", { place: to }) } as Step;
    });
  }

  private places(p: Plan): PlaceOnWay[] {
    const seen = new Set<string>(), out: PlaceOnWay[] = [];
    for (const poi of [...p.openAlong, ...p.safeHavens, ...this.ps.havensNearOrigin] as PoiView[]) {
      if (seen.has(poi.id)) continue;
      seen.add(poi.id);
      const st = placeState(poi.open);
      if (!st) continue;
      const d = poi.distM ?? 0;
      out.push({ id: poi.id, type: PLACE_TYPE[poi.type] ?? "help", name: shortPlace(poi.name), distance_m: d, distance_text: this.dist(d), state: st, state_text: this.t(STATE_KEY[st]), lat: poi.lat, lon: poi.lon, phone: poi.phone });
    }
    return out.sort((a, b) => (PLACE_ORDER.indexOf(a.type) + 100) % 100 - (PLACE_ORDER.indexOf(b.type) + 100) % 100 || a.distance_m - b.distance_m).slice(0, 6);
  }

  private path(p: Plan): LatLon[] {
    const pts: LatLon[] = [];
    for (const s of p.segments) for (const [la, lo] of s.coords) {
      const q: LatLon = [Math.round(la * 1e6) / 1e6, Math.round(lo * 1e6) / 1e6];
      const last = pts[pts.length - 1];
      if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
    }
    return pts;
  }

  private trip(opt: Option, p: Plan): TripState {
    const dep = this.ps.departure, eta = p.eta.expected ?? dep, now = this.now;
    let idx = 0;
    p.segments.forEach((s, i) => {
      const st = s.start.expected, en = s.end.expected;
      if (st !== null && en !== null && st <= now && now < en) idx = i;
      else if (en !== null && now >= en) idx = Math.min(i + 1, p.segments.length - 1);
    });
    const progress = now <= dep ? 0 : Math.min(1, (now - dep) / Math.max(1000, eta - dep));
    const arrived = now >= eta;
    return { option_id: opt.id, step_index: idx, progress: Math.round(progress * 1000) / 1000, arrived,
      next_text: arrived ? this.t("line.arrived") : opt.steps[idx]?.text ?? "", next_icon: arrived ? "done" : opt.steps[idx]?.icon ?? "walk",
      minutes_left: Math.max(0, Math.ceil((eta - now) / 60000)), position: along(opt.path, progress) };
  }

  /** Only for a trip the user started: before Start, options simply update quietly. */
  private banner(current: string | null): SimpleView["banner"] {
    if (!this.ps.userLocked) return null;
    const log = this.ps.changeLog ?? [];
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      const key = bannerKey(e.code);
      if (!key) continue;
      if (this.now - e.t > CONFIG.presentation.bannerMaxAgeS * 1000) return null;
      return { id: `${e.t}#${e.code}`, text: this.t(key), see_option_id: current };
    }
    return null;
  }
}

function along(path: LatLon[], frac: number): LatLon | null {
  if (!path.length) return null;
  if (frac <= 0 || path.length === 1) return path[0];
  const seg = path.slice(1).map((b, i) => Math.hypot(b[0] - path[i][0], b[1] - path[i][1]));
  const target = seg.reduce((a, b) => a + b, 0) * Math.min(frac, 1);
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    if (acc + seg[i] >= target && seg[i] > 0) { const k = (target - acc) / seg[i]; return [path[i][0] + (path[i + 1][0] - path[i][0]) * k, path[i][1] + (path[i + 1][1] - path[i][1]) * k]; }
    acc += seg[i];
  }
  return path[path.length - 1];
}

/** Need-now / help results in plain words. */
export function simplePlaces(results: NeedResult[], lang: Lang): PlaceOnWay[] {
  const t = (k: CopyKey, p?: Record<string, string | number>) => format(lang, k, p);
  const dist = (m: number) => (m < 1000 ? t("fmt.meters", { n: Math.max(10, Math.round(m / 10) * 10) }) : t("fmt.km", { n: (m / 1000).toFixed(1) }));
  const out: PlaceOnWay[] = [];
  for (const r of results) {
    const st = placeState(r.open);
    if (!st) continue;
    const mins = Math.max(1, Math.round(r.minutes[1]));
    out.push({ id: r.id, type: PLACE_TYPE[r.type] ?? "help", name: shortPlace(r.name), distance_m: r.distanceM, distance_text: dist(r.distanceM), minutes: mins,
      minutes_text: t("fmt.walkMin", { n: mins }), state: st, state_text: t(STATE_KEY[st]), lat: r.lat, lon: r.lon, path: r.coords, phone: r.phone });
  }
  return out;
}

// ---- banned-word check used by tests and the scenario runner ------------------------------------------
export function bannedHits(text: string): string[] {
  const low = (text || "").toLowerCase();
  return banned.banned.filter((w) => new RegExp(`(^|[^a-z])${w.replace(/[-]/g, "\\-")}([^a-z]|$)`).test(low));
}

export function userTexts(v: SimpleView): string[] {
  const out: string[] = [];
  for (const o of v.options) {
    out.push(...[o.label, o.arrive_text, o.timing_text, o.late_text, o.safety_text, o.safety_reason, o.same_text].filter((x): x is string => !!x));
    out.push(...o.steps.map((s) => s.text));
    if (o.warning) out.push(o.warning.text, o.warning.pill ?? "");
    out.push(...o.places.map((p) => p.state_text));
  }
  if (v.banner) out.push(v.banner.text);
  if (v.trip) out.push(v.trip.next_text);
  if (v.error_text) out.push(v.error_text);
  return out.filter(Boolean);
}

export function plainViolations(v: SimpleView, maxWords = 12): string[] {
  const bad: string[] = [];
  for (const s of userTexts(v)) {
    const hits = bannedHits(s);
    if (hits.length) bad.push(`banned ${hits.join(",")} in "${s}"`);
    if (s.replace(/,/g, " ").split(/\s+/).filter(Boolean).length > maxWords) bad.push(`too long: "${s}"`);
  }
  return bad;
}

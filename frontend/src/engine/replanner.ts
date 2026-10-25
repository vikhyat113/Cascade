// Continuous re-planning with hysteresis and a change log (spec §7.3).
// The current way is "pinned" and re-evaluated every tick. It is only left when it breaks
// (closure, cancelled bus), gets late, or its data goes bad; before the user taps Start, also
// when another way is clearly better. Every decision is logged with a machine-readable code.
import { CONFIG } from "../config";
import { RANK } from "./freshness";
import { CATEGORY_LABEL, choosePlanB, planFull, type LogEntry, type Plan, type PlanRequest, type PlanSet, type RouteSpec } from "./planner";
import type { OpenCache } from "./services";
import type { State } from "./state";

export interface ActivePlan {
  id: string; request: PlanRequest; planset: PlanSet | null; pinned: RouteSpec | null; specs: Map<string, RouteSpec>;
  version: number; log: LogEntry[]; prevCats: Map<string, string>; pending: Map<string, string>;
  prevEta: number | null; prevFeas: Record<string, boolean> | null; prevPlanB: string | null; prevRecId: string | null;
  userLocked: boolean; keptNote: string | null; eventSeq: number; done: boolean; history: { t: number; confidence: number; safetyLo: number }[];
}

const feasRank = (p: Plan) => (p.feasible.worst ? 3 : p.feasible.expected ? 2 : p.feasible.best ? 1 : 0);
const etaMin = (p: Plan) => p.durationMin.expected ?? 1e9;

function brokeCode(why: string): string {
  const w = why.toLowerCase();
  if (w.includes("flood") || w.includes("water")) return "switch.flood";
  if (w.includes("closure")) return "switch.closure";
  if (w.includes("cancel") || w.includes("no catchable") || w.includes("no service")) return "switch.cancelled";
  return "switch.broke";
}

export class Replanner {
  plans = new Map<string, ActivePlan>();
  private n = 0;
  constructor(public s: State, public cache: OpenCache) {}

  private entry(ap: ActivePlan, kind: string, message: string, severity: LogEntry["severity"] = "info", code?: string, at?: number, extra: Partial<LogEntry> = {}) {
    const t = at ?? this.s.now();
    ap.log.push({ t, hhmm: this.s.world.city.hhmm(t), kind, severity, message, code: code ?? kind, ...extra });
    if (ap.log.length > 300) ap.log.splice(0, ap.log.length - 300);
  }

  create(req: PlanRequest): ActivePlan {
    const now = this.s.now();
    const r = { ...req };
    let note: string | null = null;
    if (r.start == null || r.start < now - 60000) {
      if (r.start != null) note = `Requested ${this.s.world.city.hhmm(r.start)} has passed: planning from now`;
      r.start = now;
    }
    const ap: ActivePlan = { id: `p${++this.n}-${now.toString(36)}`, request: r, planset: null, pinned: null, specs: new Map(), version: 0, log: [], prevCats: new Map(), pending: new Map(),
      prevEta: null, prevFeas: null, prevPlanB: null, prevRecId: null, userLocked: false, keptNote: null, eventSeq: this.s.eventSeq, done: false, history: [] };
    if (note) this.entry(ap, "info", note);
    this.recompute(ap, true);
    this.plans.clear();                                   // the phone follows one trip at a time
    this.plans.set(ap.id, ap);
    return ap;
  }

  tickAll(): void {
    for (const ap of this.plans.values()) {
      if (ap.done) continue;
      try {
        this.recompute(ap);
        if (ap.planset?.phase === "arrived") { ap.done = true; this.entry(ap, "info", "Trip complete (worst-case arrival has passed); plan frozen", "info", "trip.done"); }
      } catch (e) { this.entry(ap, "info", `re-plan failed: ${String(e)}`, "warn", "error"); }
    }
  }

  choose(ap: ActivePlan, planId: string): boolean {
    const spec = ap.specs.get(planId);
    if (!spec) return false;
    ap.pinned = spec; ap.userLocked = true; ap.keptNote = null;
    const title = ap.planset?.plans.find((p) => p.id === planId)?.title ?? planId;
    this.entry(ap, "choose", `User started: ${title} (kept unless it breaks, gets late or its data goes bad)`, "info", "choose");
    this.recompute(ap);
    return true;
  }

  recompute(ap: ActivePlan, initial = false): void {
    const s = this.s;
    const { ps, specs, all } = planFull(s, ap.request, this.cache, ap.pinned);
    const byId = new Map(all.map((p) => [p.id, p]));
    let recId = ps.recommendedId;
    for (const e of s.eventsSince(ap.eventSeq)) this.entry(ap, "event", e.message, e.severity, `event.${e.kind}`, e.t);
    ap.eventSeq = s.eventSeq;
    if (initial || !ap.pinned) {
      const r = recId ? byId.get(recId) : null;
      if (r) this.entry(ap, "info", `Plan: ${r.title}, arrive ${s.world.city.hhmm(r.eta.best)}-${s.world.city.hhmm(r.eta.worst)}, worst-case safety ${r.safety.lo}, data ${r.trust.status}`, "info", "plan.new");
      else this.entry(ap, "info", "No way found", "alert", "plan.none");
    } else {
      const cur = byId.get(ap.pinned.sig);
      if (!cur) {
        const why = ps.pinnedInvalid ?? "no longer available";
        if (recId) this.entry(ap, "switch", `Current way broke (${why}); switched to ${byId.get(recId)!.title}`, "alert", brokeCode(why));
        else if (ap.keptNote !== "no-route") { this.entry(ap, "switch", `Current way broke (${why}) and no other way exists`, "alert", "switch.noroute"); ap.keptNote = "no-route"; }
      } else if (recId && recId !== cur.id) {
        const nw = byId.get(recId)!;
        const [sw, why, code] = this.shouldSwitch(cur, nw, ap.userLocked);
        if (sw) { this.entry(ap, "switch", `Switched to ${nw.title}: ${why}`, "warn", code); ap.keptNote = null; }
        else {
          this.keep(ps, cur, nw, all);
          recId = cur.id;
          if (ap.keptNote !== nw.id) { this.entry(ap, "keep", `${ap.userLocked ? "Keeping the way you chose" : "Kept current plan"}; ${why}`, "info", "keep"); ap.keptNote = nw.id; }
        }
      }
    }
    const rec = recId ? byId.get(recId) ?? null : null;
    if (rec && !initial && ap.prevRecId === recId) this.diff(ap, rec);
    else if (rec) { ap.prevCats = new Map(rec.trust.categories.map((x) => [x.name, x.status])); ap.pending.clear(); }
    if (rec) {
      if (!initial) this.diffPlan(ap, rec, ps);
      ap.prevEta = rec.eta.expected; ap.prevFeas = { ...rec.feasible }; ap.prevPlanB = ps.planB?.planId ?? null; ap.prevRecId = recId;
      ap.pinned = specs.get(recId!) ?? ap.pinned;
      ap.history.push({ t: s.now(), confidence: rec.trust.confidence, safetyLo: rec.safety.lo });
      if (ap.history.length > 120) ap.history.shift();
    }
    ap.specs = specs;
    ps.id = ap.id; ps.userLocked = ap.userLocked; ps.changeLog = ap.log.slice(-80); ps.history = ap.history;
    ap.planset = ps;
    ap.version++;
  }

  private shouldSwitch(cur: Plan, nw: Plan, locked: boolean): [boolean, string, string] {
    const H = CONFIG.planner.hysteresisPoints, He = CONFIG.planner.hysteresisEtaS / 60;
    const fc = feasRank(cur), fn = feasRank(nw);
    if (fn > fc) return [true, "current way no longer on time", "switch.late"];
    if (fn < fc) return [false, `${nw.title} scores higher but is less likely to be on time`, "keep"];
    const rc = RANK[cur.trust.status], rn = RANK[nw.trust.status];
    if (rc <= RANK.OUTDATED && rn > rc) return [true, `current way relies on ${CATEGORY_LABEL[cur.trust.limiting ?? ""] ?? cur.trust.limiting} which is now ${cur.trust.status}`, "switch.data"];
    const ds = nw.safety.lo - cur.safety.lo, dt = etaMin(cur) - etaMin(nw);
    if (locked) return [false, `${nw.title} differs by ${ds >= 0 ? "+" : ""}${ds} safety / ${Math.round(-dt)} min`, "keep"];
    if (ds >= H) return [true, `worst-case safety +${ds} (threshold ${H})`, "switch.better"];
    if (dt >= He && ds >= -2) return [true, `${Math.round(dt)} min faster at similar safety`, "switch.better"];
    return [false, `${nw.title} differs by ${ds >= 0 ? "+" : ""}${ds} safety / ${Math.round(-dt)} min, below the hysteresis threshold (${H} points or ${He} min)`, "keep"];
  }

  private keep(ps: PlanSet, cur: Plan, nw: Plan, all: Plan[]): void {
    nw.labels = nw.labels.filter((l) => l !== "Recommended");
    if (!cur.labels.includes("Recommended")) cur.labels.unshift("Recommended");
    ps.plans = [cur, ...ps.plans.filter((p) => p !== cur)];
    ps.recommendedId = cur.id;
    const pb = choosePlanB(cur, all);
    if (pb) {
      if (!ps.plans.includes(pb.plan)) ps.plans.push(pb.plan);
      for (const p of ps.plans) p.labels = p.labels.filter((l) => l !== "Plan B");
      pb.plan.labels.push("Plan B");
      ps.planB = { planId: pb.plan.id, weakLink: pb.weakLink, weakStatus: pb.weakStatus, reason: pb.reason, trigger: pb.trigger };
    }
  }

  /** Status changes of the (unchanged) current way. KNOWN<->PROBABLE flips must last two ticks. */
  private diff(ap: ActivePlan, rec: Plan): void {
    for (const c of rec.trust.categories) {
      const old = ap.prevCats.get(c.name);
      if (!old) { ap.prevCats.set(c.name, c.status); continue; }
      if (old === c.status) { ap.pending.delete(c.name); continue; }
      const serious = ["OUTDATED", "UNKNOWN"].includes(c.status) || ["OUTDATED", "UNKNOWN"].includes(old);
      if (!serious && ap.pending.get(c.name) !== c.status) { ap.pending.set(c.name, c.status); continue; }
      ap.pending.delete(c.name); ap.prevCats.set(c.name, c.status);
      const down = RANK[c.status as keyof typeof RANK] < RANK[old as keyof typeof RANK];
      const sev = down ? (["OUTDATED", "UNKNOWN"].includes(c.status) ? "alert" : c.critical ? "warn" : "info") : "info";
      this.entry(ap, "status", `${c.label} ${old} -> ${c.status} (${c.detail})`, sev, `status.${c.name}.${c.status}`, undefined, { detail: c.detail, critical: c.critical });
    }
  }

  private diffPlan(ap: ActivePlan, rec: Plan, ps: PlanSet): void {
    const city = this.s.world.city;
    if (ap.prevEta && rec.eta.expected && ap.prevRecId === rec.id) {
      const d = (rec.eta.expected - ap.prevEta) / 1000;
      if (Math.abs(d) >= CONFIG.planner.etaChangeLogS) this.entry(ap, "eta", `Expected arrival ${d > 0 ? "later" : "earlier"} by ${Math.round(Math.abs(d) / 60)} min -> ${city.hhmm(rec.eta.expected)}`, d > 0 ? "warn" : "info", d > 0 ? "eta.later" : "eta.earlier");
    }
    if (ap.prevFeas && ps.deadline !== null) {
      for (const k of ["worst", "expected", "best"]) {
        if (ap.prevFeas[k] !== rec.feasible[k]) {
          const ok = rec.feasible[k];
          this.entry(ap, "feasibility", `${k} case ${ok ? "now makes" : "now misses"} the ${city.hhmm(ps.deadline)} deadline`, ok ? "info" : "alert", `feas.${ok ? "make" : "miss"}.${k}`);
          break;
        }
      }
    }
    const pb = ps.planB?.planId ?? null;
    if (pb !== ap.prevPlanB) {
      const p = ps.plans.find((x) => x.id === pb);
      if (p) this.entry(ap, "planb", `Plan B: ${p.title} (${ps.planB!.reason})`, "info", "planb.new");
      else if (!pb) this.entry(ap, "planb", "Plan B withdrawn", "info", "planb.none");
    }
  }
}

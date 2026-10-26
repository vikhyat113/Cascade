// Deterministic scenario replay + stress harness (spec §7.2). Each scenario builds a fresh Engine
// on a ManualClock (sharing the loaded World), replays minute by minute, validates every plan and
// every plain view, and checks its expectations.
import type { SourceId } from "../config";
import { RANK, type Status } from "./freshness";
import { Engine } from "./engine";
import type { Mode, PlanRequest } from "./planner";
import { needNow } from "./needs";
import { plainViolations, simplePlaces } from "./simpleView";
import { setSource, type SimEvent } from "./sim/events";
import { ManualClock } from "./time";
import { validateJson, validatePlanSet } from "./validate";
import type { World } from "./world";

export interface Scenario {
  id: string; name: string; description?: string; seed?: number; start?: string; end?: string;
  request: { from: string; to: string; finish?: string; by?: string; modes?: Mode[]; maxWalkM?: number };
  events: SimEvent[]; offline_start?: boolean; unavailable?: SourceId[];
  checks?: { type: "need_now"; kind: string; disable?: SourceId }[];
  expect: Record<string, unknown>;
}

export interface ScenarioResult {
  id: string; name: string; description: string; steps: number; passed: boolean; plan_changed: boolean; switches: string[];
  status_transitions: string[]; n_transitions: number; max_confidence_drop: number; weakest_status: Status; plan_b_offered: boolean;
  invalid_outputs: number; violations: string[]; checks: Record<string, { pass: boolean; detail: string }>;
  timeline: { t: string; status: Status; confidence: number; safety_lo: number | null }[]; duration_ms: number;
}

export const SCENARIOS: Scenario[] = Object.values(import.meta.glob<Scenario>("../scenarios/*.json", { eager: true, import: "default" }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** The night all scenarios replay on: the night of the saved weather snapshot (so the forecast exists). */
export function scenarioNight(w: World): number { return w.weatherFetchedAt ?? Date.parse(w.meta.generated_at); }

/** "home" / "work" (demo defaults), "bus:start" / "bus:end" (ends of the first bus route, so bus
 *  scenarios test the timetable logic on whatever routes the area has), or a place name. */
export function point(w: World, ref: string) {
  const d = w.meta.ui_defaults;
  const bus = /^bus:(start|end)$/.exec(ref);
  if (bus) {
    const r = [...w.routes.values()].find((x) => x.mode === "bus" && x.stops.length >= 2);
    if (!r) throw new Error("no bus route in this area");
    const s = bus[1] === "start" ? r.stops[0] : r.stops[r.stops.length - 1];
    return { lat: s.lat, lon: s.lon, name: s.name };
  }
  if (ref === "home") return { ...d.home, kind: "home" as const };
  if (ref === "work") return { ...d.work, kind: "work" as const };
  const hit = w.geocode(ref, 1)[0];
  if (!hit) throw new Error(`cannot find ${ref}`);
  return { lat: hit.lat, lon: hit.lon, name: hit.name };
}

export function runScenario(w: World, sc: Scenario): ScenarioResult {
  const t0 = Date.now();
  const ref = scenarioNight(w);
  const at = (hhmm: string) => w.city.atNight(hhmm, ref);
  const finish = at(sc.request.finish ?? "02:00");
  const deadline = sc.request.by ? at(sc.request.by) : finish + 45 * 60000;
  const start = sc.start ? at(sc.start) : finish - 10 * 60000;
  const end = sc.end ? at(sc.end) : deadline + 5 * 60000;
  const clock = new ManualClock(start);
  const eng = new Engine(w, clock, { live: false, warmup: false, seed: sc.seed ?? 42 });
  const s = eng.state;
  if (sc.offline_start) { setSource(s, "all_live", false); s.online = false; }
  for (const sid of sc.unavailable ?? []) setSource(s, sid, false);
  if (!sc.offline_start) eng.feeds.warmup(300);
  (eng as unknown as { last: number }).last = clock.now();
  const req: PlanRequest = { origin: point(w, sc.request.from), destination: point(w, sc.request.to), start: finish, deadline,
    modes: sc.request.modes ?? ["walk", "bus", "cab"], riskWeight: 1, maxWalkM: sc.request.maxWalkM ?? 2500 };
  const ap = eng.plan(req);
  const pending = [...sc.events].sort((a, b) => at(a.t!) - at(b.t!));
  const samples: ScenarioResult["timeline"] = [];
  const violations: string[] = [];
  let planB = false, conflict = false, hasPlanAll = true;
  const cats: Record<string, Status>[] = [];
  const sample = () => {
    const ps = ap.planset!;
    const view = eng.view("en")!;
    for (const v of [...validatePlanSet(ps), ...plainViolations(view).map((x) => `plain view: ${x}`)]) if (violations.length < 20) violations.push(`${w.city.hhmm(clock.now())} ${v}`);
    const rec = ps.plans.find((p) => p.id === ps.recommendedId);
    planB ||= !!ps.planB;
    conflict ||= ps.plans.some((p) => p.warnings.some((x) => x.includes("Conflicting sources")));
    hasPlanAll &&= !!rec;
    samples.push({ t: w.city.hhmm(clock.now()), status: rec?.trust.status ?? "UNKNOWN", confidence: rec?.trust.confidence ?? 0, safety_lo: rec?.safety.lo ?? null });
    cats.push(Object.fromEntries((rec?.trust.categories ?? []).map((c) => [c.name, c.status])));
  };
  sample();
  while (clock.now() < end) {
    while (pending.length && at(pending[0].t!) <= clock.now()) eng.inject(pending.shift()!);
    eng.advance(60, 60);
    sample();
  }
  const checks: ScenarioResult["checks"] = {};
  const chk = (name: string, ok: boolean, detail: string) => { checks[name] = { pass: ok, detail }; };
  for (const c of sc.checks ?? []) {
    if (c.disable) setSource(s, c.disable, false);
    const raw = needNow(s, eng.cache, c.kind, req.origin.lat, req.origin.lon);
    const bad = validateJson(raw, "need_now");
    const plain = simplePlaces(raw, "en");
    const unknownCalledOpen = plain.filter((p) => raw.find((r) => r.id === p.id)?.open.status === "UNKNOWN" && p.state !== "not_sure");
    const sure = raw.filter((r) => r.tier === 0);
    const topOk = !sure.length || raw[0].tier === 0;
    chk(`need_now:${c.kind}${c.disable ? ` (no ${c.disable})` : ""}`, !bad.length && !unknownCalledOpen.length && topOk,
      `top=${raw[0]?.name ?? "none"} [${raw[0]?.open.status ?? "-"}], not-sure listed=${plain.filter((p) => p.state === "not_sure").length}`);
    violations.push(...bad.slice(0, 3));
  }
  const log = ap.log;
  const switches = log.filter((e) => e.kind === "switch").map((e) => `${e.hhmm} ${e.message}`);
  const transitions = log.filter((e) => e.kind === "status").map((e) => `${e.hhmm} ${e.message}`);
  const conf0 = samples[0].confidence, minConf = Math.min(...samples.map((x) => x.confidence));
  const weakestSt = samples.reduce<Status>((a, x) => (RANK[x.status] < RANK[a] ? x.status : a), "KNOWN");
  const e = sc.expect;
  if (e.never_unknown_as_value) { const b = violations.filter((v) => v.includes("UNKNOWN")); chk("never_unknown_as_value", !b.length, b[0] ?? "no UNKNOWN fact carried a value"); }
  if ("plan_changed" in e) chk("plan_changed", switches.length > 0 === e.plan_changed, `${switches.length} switch(es)`);
  if (e.backup_offered) chk("backup_offered", planB, `Plan B seen: ${planB}`);
  if (e.always_has_plan) chk("always_has_plan", hasPlanAll, `${samples.length} steps`);
  if (e.still_on_time === "yes") { const ps = ap.planset!; const rec = ps.plans.find((p) => p.id === ps.recommendedId); chk("still_on_time", !!rec?.feasible.worst, `final ${JSON.stringify(rec?.feasible)}`); }
  if (e.confidence_drops) chk("confidence_drops", conf0 - minConf >= 0.1, `${conf0.toFixed(2)} -> ${minConf.toFixed(2)}`);
  if (e.safety_drops) { const lows = samples.map((x) => x.safety_lo ?? 100); chk("safety_drops", Math.min(...lows) <= lows[0] - 3, `worst-case safety ${lows[0]} -> ${Math.min(...lows)}`); }
  if (e.min_status) chk("min_status", RANK[weakestSt] <= RANK[e.min_status as Status], `weakest seen ${weakestSt}`);
  if (e.conflict_flagged) chk("conflict_flagged", conflict, conflict ? "conflict shown" : "no conflict warning");
  for (const [cat, st] of Object.entries((e.status_reaches as Record<string, Status>) ?? {})) {
    const seen = cats.map((c) => c[cat]).filter(Boolean);
    chk(`${cat}_reaches_${st}`, seen.some((v) => RANK[v] <= RANK[st]), `seen ${[...new Set(seen)].join(",")}`);
  }
  checks.valid_output = { pass: !violations.length, detail: violations[0] ?? "all outputs valid" };
  return {
    id: sc.id, name: sc.name, description: sc.description ?? "", steps: samples.length, passed: Object.values(checks).every((c) => c.pass),
    plan_changed: switches.length > 0, switches: switches.slice(0, 6), status_transitions: transitions.slice(0, 12), n_transitions: transitions.length,
    max_confidence_drop: Math.round(Math.max(0, conf0 - minConf) * 1000) / 1000, weakest_status: weakestSt, plan_b_offered: planB,
    invalid_outputs: violations.length, violations: violations.slice(0, 5), checks, timeline: samples, duration_ms: Date.now() - t0,
  };
}

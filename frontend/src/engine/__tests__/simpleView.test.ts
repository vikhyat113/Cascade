import { describe, expect, it } from "vitest";
import { needNow } from "../needs";
import type { Plan, PlanSet } from "../planner";
import { bannedHits, bannerKey, placeState, plainViolations, simplePlaces, SimpleViewBuilder, userTexts } from "../simpleView";
import { CityTime } from "../time";
import { testEngine, workHome } from "./world.fixture";

const city = new CityTime(330);
const T = (h: number, m: number) => Date.UTC(2026, 9, 25, h - 5, m - 30);   // city-local h:m on 26 Oct (IST)
const NOW = T(26, 0);                                                           // 02:00 local next day
const at = (h: number, m: number) => T(24 + h, m);
const cat = (name: string, status: Plan["trust"]["status"], critical = true, detail = "") => ({ name, label: name, status, confidence: 0.6, detail, critical });

function plan(o: Partial<Plan> & { cats?: ReturnType<typeof cat>[]; feas?: [boolean, boolean, boolean] } = {}): Plan {
  const cats = o.cats ?? [cat("closures", "KNOWN")];
  const crit = cats.filter((c) => c.critical);
  const seg = (mode: Plan["segments"][number]["mode"], a: number, b: number, extra = {}) => ({ mode, label: mode, from: "A", to: "Sitabuldi",
    start: { best: a, expected: a, worst: a }, end: { best: b, expected: b, worst: b }, durationS: { best: 300, expected: 360, worst: 420 }, distanceM: 420,
    coords: [[28.57, 77.32], [28.58, 77.33]] as [number, number][], risk: {}, safety: { lo: 60, hi: 80 }, status: "KNOWN" as const, facts: [], ...extra });
  return {
    id: o.id ?? "p1", kind: o.kind ?? "bus", lam: 1, labels: o.labels ?? ["Recommended", "Safest"], modes: [], title: "way",
    eta: { best: at(2, 40), expected: at(2, 45), worst: at(2, 55) }, durationMin: { best: 25, expected: 30, worst: 40 },
    feasible: Object.fromEntries(["best", "expected", "worst"].map((k, i) => [k, (o.feas ?? [true, true, true])[i]])),
    safety: o.safety ?? { lo: 70, hi: 85 }, risk: o.risk ?? Object.fromEntries(["lighting", "incident", "isolation", "traffic", "weather", "emergency"].map((k) => [k, { lo: 0.1, hi: 0.3 }])),
    trust: { status: "KNOWN", confidence: 0.7, limiting: crit[0]?.name ?? null, overall: "KNOWN", categories: cats },
    segments: [seg("walk", at(2, 15), at(2, 21)), seg("wait", at(2, 21), at(2, 25), { routeId: "N1" }), seg("bus", at(2, 25), at(2, 40), { routeId: "N1", to: "Khurana" }), seg("walk", at(2, 40), at(2, 45), { to: "Home (Dharampeth)" })],
    distanceM: 4000, walkM: o.walkM ?? 800, outdoorMin: 12, warnings: [], safeHavens: [], openAlong: o.openAlong ?? [], dependsOn: crit.map((c) => c.name), explanation: "x", leaveAdvice: null,
  };
}

function set(plans: Plan[], o: Partial<PlanSet> = {}): PlanSet {
  return { id: "x", phase: "before_departure", computedAt: NOW, departure: at(2, 15), deadline: at(3, 0), plans, recommendedId: plans[0]?.id ?? null, planB: null,
    feasibilityLevel: "worst", noFeasible: false, warnings: [], notes: [], weather: { key: "w", value: null, status: "UNKNOWN", confidence: 0, source: "x", ageS: null, synthetic: false, kind: null, note: null },
    closures: [], havensNearOrigin: [], pinnedInvalid: null, userLocked: true, changeLog: [], ...o };
}
const build = (ps: PlanSet, lang: "en" | "hi" = "en", now = NOW) => new SimpleViewBuilder(ps, lang, now, city, "live", { name: "Home (Dharampeth)", kind: "home" }).build();
const tab = (v: ReturnType<typeof build>, id = "safest") => v.options.find((o) => o.id === id)!;

describe("simple view mapping", () => {
  it("says when you arrive and whether you are on time", () => {
    expect(tab(build(set([plan()])))).toMatchObject({ arrive_text: "Home by 2:45", timing: "on_time", timing_text: "On time" });
    expect(tab(build(set([plan({ feas: [true, true, false] })])))).toMatchObject({ timing: "maybe_late", late_text: "Maybe 2:55" });
    expect(tab(build(set([plan({ feas: [false, false, false] })])))).toMatchObject({ timing: "too_late", timing_text: "Too late" });
    expect(tab(build(set([plan()], { deadline: null }))).timing).toBe("none");
  });
  it.each([[80, "safe"], [66, "safe"], [65, "ok"], [55, "ok"], [54, "careful"]])("worst-case safety %i -> %s", (lo, level) => {
    expect(tab(build(set([plan({ safety: { lo, hi: lo + 10 } })]))).safety_level).toBe(level);
  });
  it("shows no warning when everything is sure", () => {
    expect(tab(build(set([plan({ cats: [cat("transit_timing", "KNOWN"), cat("closures", "KNOWN")] })]))).warning).toBeNull();
  });
  it("says 'Bus time is a guess.' on timetable-only timing, with a Backup", () => {
    const bus = plan({ cats: [cat("transit_timing", "PROBABLE", true, "N1 02:34: timetable only (no live)"), cat("closures", "KNOWN")] });
    const walk = plan({ id: "p2", kind: "walk", labels: ["Fastest"], cats: [cat("weather", "KNOWN"), cat("closures", "KNOWN")] });
    const o = tab(build(set([bus, walk])));
    expect(o.warning).toMatchObject({ text: "Bus time is a guess.", pill: "Likely", backup_option_id: "fastest", safe_wait: false });
  });
  it("says 'Not sure buses run now.' when hours are not known, and offers waiting somewhere safe when nothing else runs", () => {
    const bus = plan({ cats: [cat("transit_timing", "UNKNOWN", true, "E1: service hours not known (estimated route)"), cat("closures", "KNOWN")] });
    expect(tab(build(set([bus])))).toMatchObject({ warning: { text: "Not sure buses run now.", pill: "Not sure", backup_option_id: null, safe_wait: true } });
  });
  it("says a change of bus in plain words", () => {
    const p = plan();
    p.segments[1] = { ...p.segments[1], change: true };
    expect(tab(build(set([p]))).steps[1].text).toBe("Change here. Wait about 6 min.");
  });
  it("flags old or unknown critical info in plain words", () => {
    expect(tab(build(set([plan({ kind: "walk", cats: [cat("weather", "UNKNOWN"), cat("closures", "KNOWN")] })]))).warning).toMatchObject({ text: "Not sure about rain.", pill: "Not sure" });
    expect(tab(build(set([plan({ kind: "walk", cats: [cat("closures", "OUTDATED"), cat("weather", "KNOWN")] })]))).warning).toMatchObject({ text: "Road info is old.", pill: "Old info" });
  });
  it("never claims lit roads unless mapped", () => {
    const p = plan({ kind: "walk", cats: [cat("closures", "KNOWN"), cat("lighting", "PROBABLE", false)] });
    p.openAlong = [{ id: "s", name: "Shop", type: "shop", lat: 0, lon: 0, open: { key: "k", value: true, status: "KNOWN", confidence: 0.8, source: "osm", ageS: 1, synthetic: false, kind: "observed", note: null }, distM: 20, phone: null }];
    const r = tab(build(set([p]))).safety_reason.toLowerCase();
    expect(r).toContain("main roads");
    expect(r).toContain("shops open on the way");
    expect(r).not.toContain("lit");
  });
  it("turns the newest plan change into one banner, only during a started trip", () => {
    const log = [{ t: NOW - 60000, hhmm: "01:59", kind: "switch", severity: "alert" as const, message: "x", code: "switch.closure" }];
    expect(build(set([plan()], { changeLog: log })).banner?.text).toBe("Road ahead is closed. New way found.");
    expect(build(set([plan()], { changeLog: log, userLocked: false })).banner).toBeNull();
    expect(bannerKey("status.traffic.OUTDATED")).toBeNull();
  });
  it("maps open states to three words", () => {
    expect(placeState({ status: "KNOWN", value: true })).toBe("open");
    expect(placeState({ status: "PROBABLE", value: true })).toBe("maybe_open");
    expect(placeState({ status: "UNKNOWN", value: null })).toBe("not_sure");
    expect(placeState({ status: "KNOWN", value: false })).toBeNull();
  });
  it("speaks Hindi", () => {
    expect(tab(build(set([plan()]), "hi"))).toMatchObject({ arrive_text: "2:45 तक घर", timing_text: "समय पर" });
  });
  it("catches engineer words", () => {
    expect(new Set(bannedHits("ETA uncertain: feed is stale"))).toEqual(new Set(["eta", "feed", "stale"]));
    expect(bannedHits("Bus time is a guess.")).toEqual([]);
  });
});

describe("simple view on the live engine", () => {
  it("is plain, and says 'Bus time is a guess.' after bus info is lost (simulated night buses)", () => {
    const e = testEngine();
    e.state.pretendNightBuses = true;
    e.plan(workHome(e, { modes: ["walk", "bus"], finish: "02:20", by: "03:30", along: "bus" }));
    const v1 = e.view("en")!;
    expect(userTexts(v1).length).toBeGreaterThan(5);
    expect(plainViolations(v1)).toEqual([]);
    e.outage("transit_realtime", false);
    e.advance(120 * 11);
    const v2 = e.view("en")!;
    expect(plainViolations(v2)).toEqual([]);
    const bus = v2.options.filter((o) => o.kind === "bus");
    expect(bus.length).toBeGreaterThan(0);
    expect(bus[0].warning?.text).toBe("Bus time is a guess.");
  });
  it("never invents night buses: unknown hours say 'Not sure buses run now.' with a Backup", () => {
    const e = testEngine();
    e.plan(workHome(e, { modes: ["walk", "bus"], finish: "02:20", by: "03:30", along: "bus" }));
    const v = e.view("en")!;
    expect(plainViolations(v)).toEqual([]);
    const bus = v.options.filter((o) => o.kind === "bus");
    expect(bus.length).toBeGreaterThan(0);
    expect(bus[0].warning?.text).toBe("Not sure buses run now.");
    expect(bus[0].warning?.backup_option_id !== null || bus[0].warning?.safe_wait === true).toBe(true);
  });
  it("open now never calls an unknown-hours place open", () => {
    const e = testEngine();
    const d = e.world.meta.ui_defaults.work;
    const raw = needNow(e.state, e.cache, "pharmacy", d.lat, d.lon);
    const plain = simplePlaces(raw, "en");
    raw.forEach((r, i) => { if (r.open.status === "UNKNOWN") { expect(r.open.value).toBeNull(); expect(plain[i].state).toBe("not_sure"); } });
  });
});

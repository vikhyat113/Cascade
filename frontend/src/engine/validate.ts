// Output validator: the judging-critical rules, checked on anything the engine produces.
//   * a fact with status UNKNOWN never carries a value
//   * every {lo, hi} has lo <= hi; no NaN / Infinity
//   * arrival times are ordered best <= expected <= worst
//   * confidence is within [0, 1]
//   * a plan whose critical data is UNKNOWN shows a widened range
import type { PlanSet } from "./planner";

const ORDERED = new Set(["eta", "durationMin", "minutes_ordered"]);

function walk(o: unknown, path: string, out: string[]): void {
  if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${path}[${i}]`, out)); return; }
  if (o && typeof o === "object") {
    const r = o as Record<string, unknown>;
    if (r.status === "UNKNOWN" && "value" in r && r.value !== null && r.value !== undefined) out.push(`${path}: UNKNOWN fact carries a value`);
    if (typeof r.lo === "number" && typeof r.hi === "number" && r.lo > r.hi + 1e-9) out.push(`${path}: interval lo > hi`);
    if (ORDERED.has(path.split(".").pop() ?? "") && ["best", "expected", "worst"].every((k) => typeof r[k] === "number")) {
      const [a, b, c] = [r.best, r.expected, r.worst] as number[];
      if (!(a <= b + 1e-9 && b <= c + 1e-9)) out.push(`${path}: not ordered best<=expected<=worst`);
    }
    if (typeof r.confidence === "number" && (r.confidence < 0 || r.confidence > 1)) out.push(`${path}: confidence out of range`);
    for (const [k, v] of Object.entries(r)) walk(v, `${path}.${k}`, out);
    return;
  }
  if (typeof o === "number" && !isFinite(o)) out.push(`${path}: non-finite number`);
}

export function validateJson(o: unknown, root = "$"): string[] { const out: string[] = []; walk(o, root, out); return out; }

export function validatePlanSet(ps: PlanSet): string[] {
  const out = validateJson(JSON.parse(JSON.stringify(ps)));
  ps.plans.forEach((p, i) => {
    if (!p.explanation) out.push(`plans[${i}]: no explanation`);
    const unk = p.trust.categories.filter((c) => c.critical && c.status === "UNKNOWN");
    if (unk.length && p.trust.status !== "UNKNOWN") out.push(`plans[${i}]: critical UNKNOWN but headline ${p.trust.status}`);
    if (unk.length) {
      const d = p.durationMin;
      const etaW = d.worst !== null && d.best !== null ? d.worst - d.best : 99;
      if (p.safety.hi - p.safety.lo < 5 && etaW < 3) out.push(`plans[${i}]: UNKNOWN ${unk[0].name} did not widen the output`);
    }
  });
  return out;
}

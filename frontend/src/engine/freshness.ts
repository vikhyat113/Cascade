// Facts and freshness (spec §7.1): every piece of information is a Fact, and its status is
// KNOWN / PROBABLE / OUTDATED / UNKNOWN. An UNKNOWN fact never carries a value.
import { CONFIG } from "../config";

export type Status = "KNOWN" | "PROBABLE" | "OUTDATED" | "UNKNOWN";
export type Kind = "observed" | "scheduled" | "inferred" | "prior";

export interface Fact {
  key: string;
  value: unknown;              // null = we do not know
  source: string;
  synthetic: boolean;
  observedAt: number | null;   // epoch ms when the world was last observed
  ttlS: number;
  reliability: number;         // 0..1
  kind: Kind;
  contradictedBy?: string | null;
  note?: string | null;
}

export interface FactView {
  key: string;
  value: unknown;
  status: Status;
  confidence: number;
  source: string;
  ageS: number | null;
  synthetic: boolean;
  kind: Kind | null;
  note: string | null;
  interval?: [number, number] | null;
}

export const RANK: Record<Status, number> = { UNKNOWN: 0, OUTDATED: 1, PROBABLE: 2, KNOWN: 3 };
export const STATUSES: Status[] = ["KNOWN", "PROBABLE", "OUTDATED", "UNKNOWN"];
export const CODE: Record<Status, number> = { UNKNOWN: 0, OUTDATED: 1, PROBABLE: 2, KNOWN: 3 };
export const STATUS_OF: Status[] = ["UNKNOWN", "OUTDATED", "PROBABLE", "KNOWN"];

type FCfg = typeof CONFIG.freshness;
const F = CONFIG.freshness;

export function ageS(f: Fact | null | undefined, now: number): number | null {
  if (!f || f.observedAt == null) return null;
  return Math.max(0, (now - f.observedAt) / 1000);
}

export function status(f: Fact | null | undefined, now: number, c: FCfg = F): Status {
  if (!f || f.value === null || f.value === undefined) return "UNKNOWN";
  const age = ageS(f, now);
  if (age === null) return f.kind === "prior" ? "PROBABLE" : "UNKNOWN";
  const ttl = Math.max(1, f.ttlS);
  if (age > c.unusableFactor * ttl) return "UNKNOWN";
  if (f.contradictedBy) return "OUTDATED";
  if (f.kind === "observed") {
    if (age <= ttl) return f.reliability >= c.knownMinReliability ? "KNOWN" : "PROBABLE";
    if (age <= c.outdatedFactor * ttl) return "PROBABLE";
    return "OUTDATED";
  }
  return age <= ttl ? "PROBABLE" : "OUTDATED";      // scheduled / inferred / prior: inside the horizon
}

export function confidence(f: Fact | null | undefined, now: number, c: FCfg = F, st?: Status): number {
  const s = st ?? status(f, now, c);
  if (s === "UNKNOWN" || !f) return 0;
  const age = ageS(f, now) ?? 0;
  let v = f.reliability * Math.exp(-age / (c.decayScale * Math.max(1, f.ttlS)));
  v = Math.min(v, c.kindCaps[f.kind]);
  if (s === "OUTDATED") v *= c.outdatedDiscount;
  return Math.round(Math.max(0, Math.min(1, v)) * 1e4) / 1e4;
}

export function view(f: Fact | null | undefined, now: number, opts: Partial<FactView> & { key?: string } = {}): FactView {
  if (!f) {
    return { key: opts.key ?? "unknown", value: null, status: "UNKNOWN", confidence: 0, source: opts.source ?? "none",
      ageS: null, synthetic: opts.synthetic ?? false, kind: null, note: opts.note ?? "no data", interval: opts.interval ?? null };
  }
  const s = status(f, now);
  const a = ageS(f, now);
  return {
    key: opts.key ?? f.key,
    value: s === "UNKNOWN" ? null : f.value,           // the hard rule
    status: s, confidence: confidence(f, now, F, s), source: f.source,
    ageS: a === null ? null : Math.round(a * 10) / 10, synthetic: f.synthetic, kind: f.kind,
    note: opts.note ?? f.note ?? null, interval: opts.interval ?? null,
  };
}

export interface Aggregate { status: Status; confidence: number; minConfidence: number; weakestKey: string | null; n: number }

/** Weakest-link status + confidence product. `null` items count as UNKNOWN. */
export function aggregate(items: (Fact | FactView | null)[], now = 0): Aggregate {
  const views = items.map((it) => (it && "status" in it ? (it as FactView) : view(it as Fact | null, now)));
  if (!views.length) return { status: "UNKNOWN", confidence: 0, minConfidence: 0, weakestKey: null, n: 0 };
  const weak = views.reduce((a, b) => (RANK[b.status] < RANK[a.status] || (b.status === a.status && b.confidence < a.confidence) ? b : a));
  const prod = views.reduce((p, v) => p * v.confidence, 1);
  return { status: weak.status, confidence: Math.round(prod * 1e4) / 1e4,
    minConfidence: Math.min(...views.map((v) => v.confidence)), weakestKey: weak.key, n: views.length };
}

export function weakest(statuses: Status[]): Status {
  return statuses.length ? statuses.reduce((a, b) => (RANK[b] < RANK[a] ? b : a)) : "UNKNOWN";
}

/** Status of a category spread over a way: the weakest status covering >= threshold of its length. */
export function coverageStatus(w: Record<Status, number>, threshold = F.coverageThreshold): Status {
  const total = STATUSES.reduce((s, k) => s + Math.max(0, w[k] || 0), 0);
  if (total <= 0) return "UNKNOWN";
  let cum = 0;
  for (const s of ["UNKNOWN", "OUTDATED", "PROBABLE", "KNOWN"] as Status[]) {
    cum += Math.max(0, w[s] || 0) / total;
    if (cum >= threshold - 1e-9) return s;
  }
  return "KNOWN";
}

export function shares(w: Record<Status, number>): Record<Status, number> {
  const total = STATUSES.reduce((s, k) => s + (w[k] || 0), 0) || 1;
  return Object.fromEntries(STATUSES.map((k) => [k, Math.round(((w[k] || 0) / total) * 1000) / 1000])) as Record<Status, number>;
}

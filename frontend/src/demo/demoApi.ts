// Demo-drawer calls (judges only; loaded with the drawer, not in the first download).
async function j<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export type Status = "KNOWN" | "PROBABLE" | "OUTDATED" | "UNKNOWN";
export interface Source {
  id: string; label: string; live: boolean; synthetic: boolean; enabled: boolean; status: Status;
  confidence: number; age_s: number | null; reliability: number; ttl_s: number; can_toggle: boolean;
  history: { status: Status }[];
}
export interface SimState { now: string; speed: number; paused: boolean; sources: Record<string, boolean>; truth: { rain: string | null } }
export interface ScenarioResult {
  id: string; name: string; passed: boolean; plan_changed: boolean; n_transitions: number; max_confidence_drop: number;
  weakest_status: Status; plan_b_offered: boolean; invalid_outputs: number; duration_ms: number;
  checks: Record<string, { pass: boolean; detail: string }>; timeline: { confidence: number }[];
}

export const demo = {
  trust: () => j<{ sources: Source[]; hours_coverage: { shares: Record<Status, number> }; lighting_coverage: { shares: Record<Status, number> } }>("/api/trust"),
  sim: () => j<SimState>("/api/sim/state"),
  outage: (source: string, enabled: boolean) => j("/api/sim/outage", { source, enabled }),
  inject: (type: string, params: Record<string, unknown>, plan_id?: string | null) => j("/api/sim/inject", { type, params, plan_id }),
  clock: (body: { speed?: number; paused?: boolean; time?: string; advance_s?: number }) => j<SimState>("/api/sim/clock", body),
  reset: () => j("/api/sim/reset", {}),
  scenarios: () => j<{ id: string; name: string; description: string }[]>("/api/scenarios"),
  results: () => j<{ results: ScenarioResult[] }>("/api/scenarios/results"),
  runAll: () => j<{ results: ScenarioResult[] }>("/api/scenarios/run_all", {}),
  area: () => fetch("/api/area/diagnostics").then((r) => r.json()) as Promise<import("../types").AreaDiagnostics>,
};

export const OFFICIAL: Record<Status, { word: string; user: string; color: string }> = {
  KNOWN: { word: "Known", user: "(nothing shown)", color: "#34d399" },
  PROBABLE: { word: "Probable", user: "Likely", color: "#60a5fa" },
  OUTDATED: { word: "Outdated", user: "Old info", color: "#fbbf24" },
  UNKNOWN: { word: "Unknown", user: "Not sure", color: "#c3cae6" },
};

export function ago(s: number | null): string {
  if (s == null) return "never";
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

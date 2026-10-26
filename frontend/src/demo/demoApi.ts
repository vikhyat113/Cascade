// Demo-drawer calls (judges only; loaded with the drawer, not in the first download). They go to the
// on-phone engine, like everything else.
import { LIVE_SOURCES } from "../config";
import type { ScenarioResult as EngineResult } from "../engine/scenarios";
import type { SimEvent, SourceArg } from "../engine/sim/events";
import { call } from "../lib/engine";
import { THEME } from "../theme";

export type Status = "KNOWN" | "PROBABLE" | "OUTDATED" | "UNKNOWN";
export interface Source {
  id: string; label: string; live: boolean; synthetic: boolean; enabled: boolean; status: Status;
  confidence: number; age_s: number | null; reliability: number; ttl_s: number; history: Status[];
}
export interface SimState { now_text: string; speed: number; paused: boolean; sources: Record<string, boolean>; truth: { rain: string | null }; pretend: boolean }
export type ScenarioResult = EngineResult;
export interface LogLine { hhmm: string; severity: string; message: string; code?: string }

const results = new Map<string, ScenarioResult>();
let runner: Worker | null = null;

export const demo = {
  trust: async () => {
    const t = await call("trust");
    return { sources: t.sources.map((s) => ({ ...s, status: s.status as Status, age_s: s.ageS, ttl_s: s.ttlS, history: s.history as Status[] })), hours: t.hours };
  },
  sim: async (): Promise<SimState> => {
    const [c, sources] = await Promise.all([call("clock"), call("sources")]);
    return { now_text: c.now_text ?? "", speed: c.speed, paused: c.paused, sources, truth: { rain: c.rain }, pretend: c.pretend };
  },
  log: () => call("log") as Promise<LogLine[]>,
  outage: (source: SourceArg, enabled: boolean) => call("outage", source, enabled),
  inject: (type: string, params: Record<string, unknown>) => call("inject", { type, params } as SimEvent),
  clock: async (o: { speed?: number; paused?: boolean; time?: string; advance_s?: number }) => {
    if (o.advance_s) return call("advance", o.advance_s);           // one step in the worker: quick taps add up
    return call("setClock", { hhmm: o.time, speed: o.speed, paused: o.paused });
  },
  reset: () => call("reset"),
  pretend: (on: boolean) => call("setPretend", on),
  scenarios: () => call("scenarios"),
  results: async () => ({ results: [...results.values()] }),
  /** All eight scenarios in their own worker; `onResult` fires as each one finishes. */
  runAll: (onResult?: (r: ScenarioResult) => void) => new Promise<{ results: ScenarioResult[] }>((ok) => {
    runner ??= new Worker(new URL("../engine/scenarioWorker.ts", import.meta.url), { type: "module" });
    runner.onmessage = (ev: MessageEvent<{ result?: ScenarioResult; done?: boolean }>) => {
      if (ev.data.result) { results.set(ev.data.result.id, ev.data.result); onResult?.(ev.data.result); }
      if (ev.data.done) ok({ results: [...results.values()] });
    };
    runner.postMessage("run");
  }),
};

/** "All live info" reads ON while any live source still runs, so one tap always means "switch them all off". */
export const anyLive = (sources: Record<string, boolean> | undefined) => LIVE_SOURCES.some((k) => sources?.[k]);

export const OFFICIAL: Record<Status, { word: string; user: string; color: string }> = {
  KNOWN: { word: "Known", user: "(nothing shown)", color: THEME.color.good },
  PROBABLE: { word: "Probable", user: "Likely", color: THEME.color.me },
  OUTDATED: { word: "Outdated", user: "Old info", color: THEME.color.warn },
  UNKNOWN: { word: "Unknown", user: "Not sure", color: THEME.color.soft },
};

export function ago(s: number | null): string {
  if (s == null) return "never";
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

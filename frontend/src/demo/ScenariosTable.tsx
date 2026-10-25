import { useEffect, useState } from "react";
import { THEME } from "../theme";
import { demo, OFFICIAL, type ScenarioResult } from "./demoApi";

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - v * 28}`).join(" ");
  return (
    <svg viewBox="0 0 100 32" className="h-8 w-24" aria-label="confidence over time" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={THEME.color.accent} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Stress-harness results (src/engine/scenarios.ts, run on the phone) with a Run button. */
export function ScenariosTable() {
  const [list, setList] = useState<{ id: string; name: string; description: string }[]>([]);
  const [res, setRes] = useState<Record<string, ScenarioResult>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    demo.scenarios().then(setList).catch(() => {});
    demo.results().then((r) => setRes(Object.fromEntries(r.results.map((x) => [x.id, x])))).catch(() => {});
  }, []);
  const run = async () => {
    setBusy(true);
    setRes({});
    try { await demo.runAll((r) => setRes((m) => ({ ...m, [r.id]: r }))); } finally { setBusy(false); }
  };
  const done = Object.values(res);
  return (
    <div>
      <div className="mb-2 flex items-center gap-3">
        <button onClick={run} disabled={busy} className="min-h-11 rounded-xl bg-accent px-4 font-bold text-accent-ink disabled:opacity-50">
          {busy ? `Running… ${Object.keys(res).length}/${list.length}` : "Run all scenarios"}
        </button>
        {done.length > 0 && <span className="font-semibold">{done.filter((r) => r.passed).length}/{done.length} pass</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-left text-[0.9rem]">
          <thead className="text-soft">
            <tr>{["Scenario", "Result", "Plan changed", "Status changes", "Max conf. drop", "Weakest", "Plan B", "Invalid", "Confidence"].map((h) => <th key={h} className="px-2 py-1.5 font-semibold">{h}</th>)}</tr>
          </thead>
          <tbody>
            {list.map((s) => {
              const r = res[s.id];
              return (
                <tr key={s.id} className="border-t border-edge align-middle" title={s.description}>
                  <td className="px-2 py-1.5 font-semibold">{s.name}</td>
                  <td className="px-2">{r ? <span className={r.passed ? "text-good" : "text-bad"}>{r.passed ? "PASS" : "FAIL"}</span> : "–"}</td>
                  <td className="px-2">{r ? (r.plan_changed ? "yes" : "no") : ""}</td>
                  <td className="px-2">{r?.n_transitions ?? ""}</td>
                  <td className="px-2">{r ? `${Math.round(r.max_confidence_drop * 100)}%` : ""}</td>
                  <td className="px-2" style={{ color: r ? OFFICIAL[r.weakest_status].color : undefined }}>{r ? OFFICIAL[r.weakest_status].word : ""}</td>
                  <td className="px-2">{r ? (r.plan_b_offered ? "yes" : "no") : ""}</td>
                  <td className={`px-2 ${r?.invalid_outputs ? "text-bad" : ""}`}>{r?.invalid_outputs ?? ""}</td>
                  <td className="px-2">{r && <Spark values={r.timeline.map((x) => x.confidence)} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

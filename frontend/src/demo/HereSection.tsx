import { useState } from "react";
import { CONFIG } from "../config";
import type { SimpleView } from "../types";
import { hereKey, hereTransitCheck, setTileTest, useHereStats, type TileTest, type TransitCheck } from "../lib/here";

const TRAFFIC: Record<string, string> = {
  off: "not asked (no key, or switched off): traffic is simulated",
  live: "HERE answers: traffic speeds are real",
  no_coverage: "HERE has no traffic data for this area: traffic is simulated",
  denied: "HERE refused the key for traffic: traffic is simulated",
  failed: "HERE traffic did not answer: the last reading ages (then simulated after a clock jump)",
};
const BASEMAP = { here: "HERE night tiles", osm: "OpenStreetMap tiles (night filter)", roads: "bundled roads (offline drawing)" };

/** Demo section 11 (UPGRADE §9): what the HERE online extras do right now, with honest labels. */
export function HereSection({ view }: { view: SimpleView | null }) {
  const st = useHereStats();
  const [check, setCheck] = useState<TransitCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const key = !!hereKey();
  const best = view?.options.find((o) => o.start && o.end) ?? null;
  const ours = best?.steps.map((s) => `${s.icon}${s.line ? ` ${s.line}` : ""} ${s.minutes} min`).join(" → ");

  const Test = ({ id, label }: { id: TileTest; label: string }) => (
    <button onClick={() => setTileTest(id)} aria-pressed={st.tileTest === id}
      className={`min-h-12 rounded-2xl border px-2 text-[0.95rem] font-semibold ${st.tileTest === id ? "border-accent bg-accent/15" : "border-edge bg-raised"}`}>{label}</button>
  );

  return (
    <div className="space-y-2 text-[0.95rem]">
      <p>Key: <b>{key ? "found in frontend/.env.local" : "none"}</b> · provider <b>{CONFIG.map.provider}</b> · map now: <b>{BASEMAP[st.basemap]}</b></p>
      {!key && <p className="text-soft">Paste <code>VITE_HERE_API_KEY=…</code> into <code>frontend/.env.local</code> and rebuild. Without it: OSM tiles and simulated traffic.</p>}
      <div className="grid grid-cols-3 gap-2">
        <Test id="normal" label="Tiles normal" />
        <Test id="here_fails" label="HERE fails" />
        <Test id="all_fail" label="All tiles fail" />
      </div>
      <p className="text-soft">Fallback: HERE → OpenStreetMap → bundled roads. Never two basemaps; tiles are not saved for offline use.</p>
      <p>Traffic: {TRAFFIC[st.traffic.state]}{st.traffic.state === "live" ? ` (${st.traffic.segments} road pieces)` : ""}</p>
      <table className="w-full text-left font-mono text-[0.85rem]">
        <thead><tr className="text-soft"><th>HERE product</th><th>requests</th><th>errors</th></tr></thead>
        <tbody>
          {(["tiles", "traffic", "transit"] as const).map((p) => (
            <tr key={p}><td>{p}</td><td>{st.requests[p]}</td><td>{st.errors[p]}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="text-[0.85rem] text-soft">Answered from the in-memory cache: {st.cached}. Traffic every {CONFIG.here.trafficEveryS} s at most; free allowances are per product.</p>
      <button disabled={!key || !best || busy} className="min-h-12 w-full rounded-2xl border border-edge bg-raised px-3 font-semibold disabled:opacity-40"
        onClick={async () => {
          if (!best?.start || !best.end) return;
          setBusy(true);
          setCheck(await hereTransitCheck({ lat: best.start[0], lon: best.start[1] }, { lat: best.end[0], lon: best.end[1] }));
          setBusy(false);
        }}>
        {busy ? "Asking HERE…" : "Cross-check public transport with HERE"}
      </button>
      {!best && <p className="text-[0.85rem] text-soft">Find a way first; the check uses its start and end.</p>}
      {check && (
        <div className="rounded-xl bg-raised p-2 text-[0.9rem]">
          <p className="font-semibold">{check.text}</p>
          {check.ways.map((w, i) => <p key={i} className="font-mono text-[0.8rem]">HERE {i + 1}: {w}</p>)}
          {ours && <p className="font-mono text-[0.8rem] text-soft">ours: {ours}</p>}
          <p className="text-[0.8rem] text-soft">Comparison only: the app never plans on HERE transit.</p>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { SimpleView } from "../types";
import { ago, anyLive, demo, OFFICIAL, type LogLine, type SimState, type Source, type Status } from "./demoApi";
import { ScenariosTable } from "./ScenariosTable";

/** Hidden Demo drawer (UI_SPEC §5). For judges: technical words are allowed here. The main
 *  screens react on their own (pill, banner, Backup) because they only read the plan stream. */
export default function DemoDrawer({ view, onClose }: { view: SimpleView | null; onClose: () => void }) {
  const [sim, setSim] = useState<SimState | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [time, setTime] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({ break: true, happen: true, time: true });
  const [log, setLog] = useState<LogLine[]>([]);

  const refresh = useCallback(() => {
    demo.sim().then(setSim).catch(() => {});
    demo.trust().then((t) => setSources(t.sources)).catch(() => {});
    demo.log().then((l) => setLog([...l].reverse())).catch(() => {});
  }, []);
  useEffect(() => { refresh(); const id = window.setInterval(refresh, 2000); return () => window.clearInterval(id); }, [refresh]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); setMsg(ok); } catch (e) { setMsg(`Failed: ${(e as Error).message}`); }
    refresh();
  };
  const planId = view?.id ?? null;
  // "All live info" reads ON while any live feed still works, so one tap always means "kill them all"
  const on = (id: string) => (id === "all_live" ? anyLive(sim?.sources) : !!sim?.sources[id]);

  const Toggle = ({ id, label }: { id: string; label: string }) => (
    <button onClick={() => act(() => demo.outage(id as Parameters<typeof demo.outage>[0], !on(id)), `${label} ${on(id) ? "OFF" : "ON"}`)}
      className={`flex min-h-14 items-center justify-between gap-2 rounded-2xl border px-4 font-bold ${on(id) ? "border-good/60 bg-good/10" : "border-bad/60 bg-bad/10"}`}
      aria-pressed={on(id)}>
      <span>{label}</span><span className={on(id) ? "text-good" : "text-bad"}>{on(id) ? "ON" : "OFF"}</span>
    </button>
  );
  const Act = ({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled} className="min-h-12 rounded-2xl border border-edge bg-raised px-3 font-semibold disabled:opacity-40">{label}</button>
  );
  const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
    <section className="border-t border-edge py-3">
      <button className="flex min-h-11 w-full items-center justify-between text-left text-[1.1rem] font-bold" aria-expanded={!!open[id]}
        onClick={() => setOpen({ ...open, [id]: !open[id] })}>
        {title}<span aria-hidden="true">{open[id] ? "−" : "+"}</span>
      </button>
      {open[id] && <div className="mt-2">{children}</div>}
    </section>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60" onClick={onClose}>
      <div className="scroll-quiet max-h-[88dvh] w-full max-w-[680px] overflow-y-auto rounded-t-3xl border-t border-edge bg-surface px-5 pb-8 pt-4"
        onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Demo controls">
        <div className="flex items-center justify-between">
          <h2 className="text-[1.3rem] font-bold">Demo <span className="text-[0.95rem] font-normal text-soft">for judges · everything here is simulated</span></h2>
          <button onClick={onClose} className="min-h-11 rounded-xl border border-edge px-4 font-semibold">Close</button>
        </div>
        {msg && <p className="mt-2 text-accent">{msg}</p>}

        <Section id="break" title="1. Break things">
          <div className="grid grid-cols-2 gap-2">
            <Toggle id="traffic" label="Traffic info" />
            <Toggle id="transit_realtime" label="Bus info" />
            <Toggle id="weather" label="Weather info" />
            <Toggle id="all_live" label="All live info" />
          </div>
          <p className="mt-2 text-[0.9rem] text-soft">Feeds that stop just age: Known → Probable → Outdated → Unknown. Use “+5 min” to see it.</p>
        </Section>

        <Section id="happen" title="2. Make it happen">
          <div className="grid grid-cols-2 gap-2">
            {sim?.truth.rain
              ? <Act label="Rain stops" onClick={() => act(() => demo.inject("rain_stop", {}), "Rain stopped")} />
              : <Act label="Rain starts" onClick={() => act(() => demo.inject("rain_start", { intensity: "heavy" }), "Heavy rain started (ground truth)")} />}
            <Act label="Road closed" disabled={!planId} onClick={() => act(() => demo.inject("road_closure", { edge_selector: "main_road_nearest_route", reason: "police barricade" }), "Main road on the way closed")} />
            <Act label="Bus cancelled" disabled={!planId} onClick={() => act(() => demo.inject("bus_cancelled", {}), "Bus cancelled")} />
            <Act label="Accident" disabled={!planId} onClick={() => act(() => demo.inject("accident", { edge_selector: "main_road_nearest_route" }), "Accident on the way")} />
          </div>
          {!planId && <p className="mt-2 text-[0.9rem] text-soft">Find a way first: these act on the current trip.</p>}
        </Section>

        <Section id="time" title="3. Time">
          <p className="mb-2 font-mono text-[1.1rem]">{sim ? sim.now_text : "--:--"} {sim?.paused ? "(paused)" : `×${sim?.speed}`}</p>
          <div className="flex flex-wrap gap-2">
            <Act label={sim?.paused ? "▶ Run" : "⏸ Pause"} onClick={() => act(() => demo.clock({ paused: !sim?.paused }), "Clock")} />
            {[1, 10, 60].map((s) => <Act key={s} label={`${s}×`} onClick={() => act(() => demo.clock({ speed: s, paused: false }), `Speed ${s}×`)} />)}
            <Act label="+5 min" onClick={() => act(() => demo.clock({ advance_s: 300 }), "+5 min")} />
            <Act label="Reset" onClick={() => act(() => demo.reset(), "Simulation reset (real time)")} />
          </div>
          <div className="mt-2 flex gap-2">
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Set sim time"
              className="min-h-12 rounded-xl border border-edge bg-raised px-3 text-ink" />
            <Act label="Set time" disabled={!time} onClick={() => act(() => demo.clock({ time }), `Time set to ${time}`)} />
          </div>
        </Section>

        <Section id="scen" title="4. Scenarios">
          <ScenariosTable />
          <a href="/scenarios" className="mt-2 inline-block text-accent underline-offset-4 hover:underline">Open full page</a>
        </Section>

        <Section id="data" title="5. Data check">
          <div className="mb-2 flex flex-wrap gap-2 text-[0.9rem]">
            {(Object.keys(OFFICIAL) as Status[]).map((s) => (
              <span key={s} className="rounded-full border px-2 py-0.5" style={{ borderColor: OFFICIAL[s].color, color: OFFICIAL[s].color }}>
                {OFFICIAL[s].word} → user sees “{OFFICIAL[s].user}”
              </span>
            ))}
          </div>
          <ul className="space-y-1.5">
            {sources.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 rounded-xl bg-raised px-3 py-2">
                <span className="min-w-0">
                  <span className="font-semibold">{s.label}</span>
                  <span className="ml-2 text-[0.85rem] text-soft">{s.synthetic ? "simulated" : "real (cached)"} · age {ago(s.age_s)}{!s.enabled ? " · switched off" : ""}</span>
                </span>
                <span className="shrink-0 rounded-full border px-2 py-0.5 text-[0.85rem] font-bold"
                  style={{ borderColor: OFFICIAL[s.status].color, color: OFFICIAL[s.status].color }}>
                  {OFFICIAL[s.status].word} {s.status !== "UNKNOWN" ? `${Math.round(s.confidence * 100)}%` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section id="log" title="6. Change log (technical)">
          {log.length === 0 && <p className="text-soft">Find a way to see every re-plan explained here.</p>}
          <ol className="max-h-72 space-y-1 overflow-y-auto font-mono text-[0.85rem]">
            {log.map((e, i) => (
              <li key={i} className={e.severity === "alert" ? "text-bad" : e.severity === "warn" ? "text-warn" : "text-soft"}>
                {e.hhmm} [{e.code}] {e.message}
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </div>
  );
}

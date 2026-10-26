import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import type { AreaDiagnostics, LayerMeta, PlanRoutesResponse, SimpleView } from "../types";
import { ago, demo, OFFICIAL, type SimState, type Source, type Status } from "./demoApi";
import { ScenariosTable } from "./ScenariosTable";

/** Hidden Demo drawer (UI_SPEC §5). For judges: technical words are allowed here. The main
 *  screens react on their own (pill, banner, Backup) because they only read the plan stream. */
export default function DemoDrawer({ view, onClose }: { view: SimpleView | null; onClose: () => void }) {
  const [sim, setSim] = useState<SimState | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [areaDiag, setAreaDiag] = useState<AreaDiagnostics | null>(null);
  const [layersList, setLayersList] = useState<LayerMeta[]>([]);
  const [routesData, setRoutesData] = useState<PlanRoutesResponse | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [time, setTime] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({ break: true, happen: true, time: true, area: true, layers: true, multiroute: true });

  const refresh = useCallback(() => {
    demo.sim().then(setSim).catch(() => {});
    demo.trust().then((t) => setSources(t.sources)).catch(() => {});
    demo.area().then(setAreaDiag).catch(() => {});
    api.layers().then(setLayersList).catch(() => {});
    if (view?.id) {
      api.planRoutes(view.id).then(setRoutesData).catch(() => {});
    }
  }, [view?.id]);
  useEffect(() => { refresh(); const id = window.setInterval(refresh, 2000); return () => window.clearInterval(id); }, [refresh]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); setMsg(ok); } catch (e) { setMsg(`Failed: ${(e as Error).message}`); }
    refresh();
  };
  const planId = view?.id ?? null;
  // "All live info" reads ON while any live feed still works, so one tap always means "kill them all"
  const on = (id: string) => (id === "all_live"
    ? ["traffic_live", "transit_realtime", "weather_live", "closures_feed", "cab_availability", "incident_reports"].some((k) => sim?.sources[k])
    : !!sim?.sources[id]);

  const Toggle = ({ id, label }: { id: string; label: string }) => (
    <button onClick={() => act(() => demo.outage(id, !on(id)), `${label} ${on(id) ? "OFF" : "ON"}`)}
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

  const log = [...(view?.details?.change_log ?? [])].reverse();
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
            <Toggle id="traffic_live" label="Traffic info" />
            <Toggle id="transit_realtime" label="Bus info" />
            <Toggle id="weather_live" label="Weather info" />
            <Toggle id="all_live" label="All live info" />
          </div>
          <p className="mt-2 text-[0.9rem] text-soft">Feeds that stop just age: Known → Probable → Outdated → Unknown. Use “+5 min” to see it.</p>
        </Section>

        <Section id="happen" title="2. Make it happen">
          <div className="grid grid-cols-2 gap-2">
            {sim?.truth.rain
              ? <Act label="Rain stops" onClick={() => act(() => demo.inject("rain_stop", {}), "Rain stopped")} />
              : <Act label="Rain starts" onClick={() => act(() => demo.inject("rain_start", { intensity: "heavy" }), "Heavy rain started (ground truth)")} />}
            <Act label="Road closed" disabled={!planId} onClick={() => act(() => demo.inject("road_closure", { edge_selector: "main_road_nearest_route", reason: "police barricade" }, planId), "Main road on the way closed")} />
            <Act label="Bus cancelled" disabled={!planId} onClick={() => act(() => demo.inject("bus_cancelled", {}, planId), "Bus cancelled")} />
            <Act label="Accident" disabled={!planId} onClick={() => act(() => demo.inject("accident", { edge_selector: "main_road_nearest_route" }, planId), "Accident on the way")} />
          </div>
          {!planId && <p className="mt-2 text-[0.9rem] text-soft">Find a way first: these act on the current trip.</p>}
        </Section>

        <Section id="time" title="3. Time">
          <p className="mb-2 font-mono text-[1.1rem]">{sim ? sim.now.slice(11, 19) : "--:--:--"} {sim?.paused ? "(paused)" : `×${sim?.speed}`}</p>
          <div className="flex flex-wrap gap-2">
            <Act label={sim?.paused ? "▶ Run" : "⏸ Pause"} onClick={() => act(() => demo.clock({ paused: !sim?.paused }), "Clock")} />
            {[1, 10, 60].map((s) => <Act key={s} label={`${s}×`} onClick={() => act(() => demo.clock({ speed: s, paused: false }), `Speed ${s}×`)} />)}
            <Act label="+5 min" onClick={() => act(() => demo.clock({ advance_s: 300 }), "+5 min")} />
            <Act label="Reset" onClick={() => act(() => demo.reset(), "Simulation reset (02:00, paused)")} />
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

        <Section id="area" title="6. Area verification (Data Trust)">
          {areaDiag ? (
            <div className="space-y-2 text-[0.88rem]">
              {areaDiag.placeholder_suspect && (
                <div className="rounded-xl border border-bad/80 bg-bad/20 p-3 font-semibold text-bad">
                  ⚠️ Red Warning: Placeholder / synthetic regular polygon suspect (distances from centroid within 3% or regular 17-gon)
                </div>
              )}
              {areaDiag.area_mode === "circle_fallback" && (
                <div className="rounded-xl border border-bad/80 bg-bad/20 p-3 font-semibold text-bad">
                  ⚠️ Red Warning: Using circular fallback mode (no polygon configured)
                </div>
              )}
              {areaDiag.stale_data && (
                <div className="rounded-xl border border-bad/80 bg-bad/20 p-3 font-semibold text-bad">
                  ⚠️ Red Warning: Stale data — graph or POIs generated before polygon file modified time! Run python scripts/fetch_all.py --force
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl bg-raised p-2.5">
                  <div className="text-[0.75rem] text-soft">Area Mode</div>
                  <div className="font-bold">
                    <span className={`inline-block rounded-md px-2 py-0.5 text-[0.8rem] ${areaDiag.area_mode === "polygon" ? "bg-good/20 text-good" : "bg-bad/20 text-bad"}`}>
                      {areaDiag.area_mode}
                    </span>
                  </div>
                </div>
                <div className="rounded-xl bg-raised p-2.5">
                  <div className="text-[0.75rem] text-soft">Coverage Area</div>
                  <div className="font-bold">{areaDiag.area_km2} km² · {areaDiag.vertex_count} vertices</div>
                </div>
              </div>

              <div className="rounded-xl bg-raised p-2.5">
                <div className="text-[0.75rem] text-soft">Area Source File</div>
                <div className="break-all font-mono text-[0.8rem] text-ink">{areaDiag.area_source}</div>
                <div className="mt-1 text-[0.75rem] text-soft">Source modified: <span className="font-mono text-ink">{areaDiag.source_mtime || "N/A"}</span></div>
              </div>

              <div className="rounded-xl bg-raised p-2.5">
                <div className="text-[0.75rem] text-soft">Bounding Box [minLon, minLat, maxLon, maxLat]</div>
                <div className="font-mono text-[0.8rem] text-ink">{JSON.stringify(areaDiag.bbox)}</div>
              </div>

              <div className="rounded-xl bg-raised p-2.5">
                <div className="text-[0.75rem] text-soft">Graph Nodes & Edges</div>
                <div className="mt-1 flex justify-between text-[0.82rem]">
                  <span>Walk: {areaDiag.walk_nodes} nodes, {areaDiag.walk_edges} edges</span>
                  <span className="font-semibold text-good">{areaDiag.walk_nodes_inside}/{areaDiag.walk_nodes} inside</span>
                </div>
                <div className="mt-1 flex justify-between text-[0.82rem]">
                  <span>Drive: {areaDiag.drive_nodes} nodes, {areaDiag.drive_edges} edges</span>
                  <span className="font-semibold text-good">{areaDiag.drive_nodes_inside}/{areaDiag.drive_nodes} inside</span>
                </div>
                <div className="mt-1.5 flex items-center justify-between border-t border-edge/60 pt-1 font-semibold">
                  <span>Share of nodes inside polygon:</span>
                  <span className={areaDiag.share_nodes_inside >= 99 ? "text-good" : "text-bad"}>
                    {areaDiag.share_nodes_inside.toFixed(2)}%
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl bg-raised p-2.5">
                  <div className="text-[0.75rem] text-soft">POIs Inside Area</div>
                  <div className="font-bold text-good">{areaDiag.pois_inside}</div>
                </div>
                <div className="rounded-xl bg-raised p-2.5">
                  <div className="text-[0.75rem] text-soft">POIs Outside Area</div>
                  <div className="font-bold text-soft">{areaDiag.pois_outside}</div>
                </div>
              </div>

              <div className="rounded-xl bg-raised p-2.5">
                <div className="text-[0.75rem] text-soft">Data Generation Timestamps</div>
                <div className="mt-1 text-[0.8rem]">
                  <div>graph_walk: <span className="font-mono text-ink">{areaDiag.walk_generated_at || "N/A"}</span></div>
                  <div>pois.json: <span className="font-mono text-ink">{areaDiag.pois_generated_at || "N/A"}</span></div>
                  <div>area modified: <span className="font-mono text-ink">{areaDiag.source_mtime || "N/A"}</span></div>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-soft">Loading area diagnostics…</p>
          )}
        </Section>

        <Section id="layers" title="7. Data Layers (Polygon-Clipped & Live)">
          <div className="space-y-3">
            {layersList.map((layer) => {
              const chip = layer.status_chip || "CACHED";
              let chipColor = "#38bdf8";
              if (chip === "LIVE") chipColor = "#34d399";
              else if (chip === "STALE") chipColor = "#fbbf24";
              else if (chip === "OFFLINE") chipColor = "#f87171";

              // Check if older than TTL
              // Weather TTL = 15m (live) / 24h (forecast). Thermal TTL = 3 days. VIIRS TTL = 45 days.
              const ttlS = layer.id === "weather_grid" ? 86400 : layer.id === "thermal_lst" ? 259200 : 3888000;
              const isOlderThanTtl = (layer.age_s ?? 0) > ttlS;
              const isMissingOrStale = !layer.available || layer.older_than_area || isOlderThanTtl;

              return (
                <div key={layer.id} className="rounded-xl border border-edge bg-raised p-3 text-[0.85rem]">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-ink">{layer.name}</span>
                    <div className="flex items-center gap-1.5">
                      <span
                        className="rounded-md px-2 py-0.5 text-[0.75rem] font-bold"
                        style={{ backgroundColor: `${chipColor}22`, color: chipColor, border: `1px solid ${chipColor}44` }}
                      >
                        {chip}
                      </span>
                      <span className="font-mono text-[0.78rem] text-soft">{ago(layer.age_s)}</span>
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[0.8rem] text-soft">
                    <div>Live flag: <span className={layer.live ? "text-good font-semibold" : "text-soft"}>{layer.live ? "ON" : "OFF"}</span></div>
                    <div>Status: <span className="text-ink font-semibold">{layer.status}</span></div>
                    <div>Source: <span className="text-ink">{layer.source}</span></div>
                    <div>Resolution: <span className="text-ink">{layer.native_resolution}</span></div>
                    <div>Last fetch / retrieved: <span className="font-mono text-ink text-[0.75rem]">{layer.retrieved_at ? layer.retrieved_at.slice(0, 19) + "Z" : "N/A"}</span></div>
                    <div>Newest timestamp: <span className="font-mono text-ink text-[0.75rem]">{layer.last_pass_date || (layer.retrieved_at ? layer.retrieved_at.slice(0, 10) : "N/A")}</span></div>
                    <div>Inside polygon: <span className="text-ink font-semibold">{layer.cell_count} cells</span></div>
                    <div>UNKNOWN share: <span className="text-good font-semibold">{layer.unknown_share}%</span></div>
                  </div>

                  {layer.error && (
                    <div className="mt-2 rounded-lg bg-bad/20 border border-bad/50 p-2 text-[0.8rem] font-semibold text-bad">
                      Error: {layer.error}
                    </div>
                  )}

                  {isMissingOrStale && (
                    <div className="mt-2 rounded-lg bg-bad/20 border border-bad/50 p-2 text-[0.8rem] font-semibold text-bad">
                      {!layer.available
                        ? "⚠ Red Warning: Layer file missing from data/ directory!"
                        : isOlderThanTtl
                        ? `⚠ Red Warning: Layer file is older than its TTL (${Math.round(ttlS / 3600)}h)!`
                        : "⚠ Warning: Layer file is older than area.geojson!"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>

        <Section id="log" title="8. Change log (technical)">
          {log.length === 0 && <p className="text-soft">Find a way to see every re-plan explained here.</p>}
          <ol className="max-h-72 space-y-1 overflow-y-auto font-mono text-[0.85rem]">
            {log.map((e: { hhmm: string; severity: string; message: string; code: string }, i: number) => (
              <li key={i} className={e.severity === "alert" ? "text-bad" : e.severity === "warn" ? "text-warn" : "text-soft"}>
                {e.hhmm} [{e.code}] {e.message}
              </li>
            ))}
          </ol>
        </Section>

        <Section id="multiroute" title="9. Multi-Route Engine & Evaluation">
          {!view?.id ? (
            <p className="text-soft text-[0.9rem]">Find a way first to see multi-route Yen paths and evaluation breakdown.</p>
          ) : !routesData ? (
            <p className="text-soft text-[0.9rem]">Loading routes...</p>
          ) : (
            <div className="space-y-3 text-[0.88rem]">
              <div className="grid grid-cols-2 gap-2 rounded-xl bg-raised p-3 text-[0.82rem]">
                <div>Base Search: <span className="font-semibold text-ink">Dijkstra (Safety-aware cost)</span></div>
                <div>Alternative Engine: <span className="font-semibold text-ink">Yen's K-Shortest Loopless Paths</span></div>
                <div>Parameters: <span className="font-semibold text-ink">K=8 (max 12), Budget=1.5s, Buffer=1.5km</span></div>
                <div>Diversity Filter: <span className="font-semibold text-ink">Overlap ≤ 70%, Cost ratio ≤ 1.6</span></div>
                <div>Execution Time: <span className="font-mono font-semibold text-good">{routesData.routing_time_ms ? `${routesData.routing_time_ms.toFixed(1)} ms` : "N/A"}</span></div>
                <div>Diverse Routes Kept: <span className="font-semibold text-ink">{routesData.routes.length}</span></div>
                <div className="col-span-2">
                  Decision Status:{" "}
                  <span className={routesData.tie ? "font-semibold text-warn" : "font-semibold text-good"}>
                    {routesData.tie ? `Close Choice / Honest Tie: ${routesData.tie_note || "Safety intervals overlap > 70%"}` : "Clear Winner Recommended"}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="font-bold text-ink">Candidate Routes & Score Breakdown:</h4>
                {routesData.routes.map((r) => (
                  <div
                    key={r.id}
                    className={`rounded-xl border p-3 ${
                      r.recommended
                        ? "border-accent/60 bg-accent/10"
                        : r.dominated
                        ? "border-edge/50 bg-raised/30 opacity-70"
                        : "border-edge bg-raised"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-ink">{r.label} ({r.id})</span>
                        {r.recommended && (
                          <span className="rounded-md bg-accent px-2 py-0.5 text-[0.72rem] font-bold text-night">
                            RECOMMENDED
                          </span>
                        )}
                        {r.dominated && (
                          <span className="rounded-md bg-bad/20 text-bad border border-bad/40 px-2 py-0.5 text-[0.72rem] font-bold">
                            PARETO DOMINATED
                          </span>
                        )}
                      </div>
                      <span className="font-mono font-bold text-accent">
                        Score: {r.score.toFixed(3)}
                      </span>
                    </div>

                    <p className="mt-1 text-[0.8rem] text-soft italic">"{r.why}"</p>

                    <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[0.78rem] text-soft border-t border-edge/60 pt-2">
                      <div>
                        Safety (wt 0.40): <span className="text-ink font-mono">[{Math.round(r.metrics.safety.lo * 100)}%, {Math.round(r.metrics.safety.hi * 100)}%]</span> (sub-score: {r.score_breakdown?.worst_case_safety?.toFixed(2) ?? "N/A"})
                      </div>
                      <div>
                        Deadline Slack (wt 0.25): <span className="text-ink font-mono">{r.metrics.slack_min}m</span> (sub-score: {r.score_breakdown?.deadline_slack?.toFixed(2) ?? "N/A"})
                      </div>
                      <div>
                        Outdoor Exposure (wt 0.15): <span className="text-ink font-mono">{r.metrics.outdoor_min}m</span> (sub-score: {r.score_breakdown?.outdoor_exposure?.toFixed(2) ?? "N/A"})
                      </div>
                      <div>
                        Unlit Share (wt 0.10): <span className="text-ink font-mono">{Math.round(r.metrics.unknown_lighting_share * 100)}%</span> (sub-score: {r.score_breakdown?.unknown_share?.toFixed(2) ?? "N/A"})
                      </div>
                      <div className="col-span-2">
                        Safe Haven Proximity (wt 0.10): <span className="text-ink font-mono">{r.metrics.safe_haven_dist_m}m</span> (sub-score: {r.score_breakdown?.safe_haven_proximity?.toFixed(2) ?? "N/A"})
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

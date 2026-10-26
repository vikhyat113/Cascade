import { useEffect, useState } from "react";
import { useT, type CopyKey } from "../copy";
import { QuietButton } from "../components/ui";
import type { MoonLight } from "../engine/astronomy";
import { call } from "../lib/engine";
import type { LayerId, LayerState } from "../lib/layers";

const ROWS: { id: LayerId; icon: string; key: CopyKey }[] = [
  { id: "lit", icon: "💡", key: "label.streetsLit" },
  { id: "heat", icon: "🌡️", key: "label.safetyHeat" },
  { id: "help", icon: "🏥", key: "label.helpPlaces" },
  { id: "weather", icon: "🌧️", key: "label.weather" },
  { id: "night", icon: "🌃", key: "label.nightLights" },
];
const MOON: Record<MoonLight["level"], CopyKey> = { bright: "label.moonBright", some: "label.moonSome", none: "label.moonNone" };

/** Round "Layers" button, just above the sheet. */
export function LayersButton({ bottom, onOpen, active }: { bottom: number; onOpen: () => void; active: boolean }) {
  const { t } = useT();
  return (
    <button onClick={onOpen} aria-label={t("label.layers")}
      className={`fixed right-3 z-20 flex h-12 w-12 items-center justify-center rounded-full border-2 text-[1.3rem] shadow-xl ${active ? "border-accent bg-accent/25" : "border-edge bg-surface"}`}
      style={{ bottom: bottom + 12 }}>
      <span aria-hidden="true">🗺️</span>
    </button>
  );
}

/** Layers sheet (UPGRADE §3): five plain switches; strength, moon light and details under "More". */
export function LayersSheet({ state, onChange, onClose, missing, nightDate, weatherTime }: {
  state: LayerState; onChange: (s: LayerState) => void; onClose: () => void;
  missing: Partial<Record<LayerId, boolean>>; nightDate: string | null; weatherTime: string | null;
}) {
  const { t } = useT();
  const [more, setMore] = useState(false);
  const [moon, setMoon] = useState<MoonLight | null>(null);
  const [lit, setLit] = useState<number | null>(null);
  useEffect(() => { if (more) { call("moon").then(setMoon).catch(() => {}); call("litStreets").then((r) => setLit(r.marked)).catch(() => {}); } }, [more]);
  const set = (p: Partial<LayerState>) => onChange({ ...state, ...p });
  const toggle = (id: LayerId) => set({ on: { ...state.on, [id]: !state.on[id] } });
  const check = "h-6 w-6 accent-accent";
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={onClose}>
      <div className="scroll-quiet max-h-[85dvh] w-full max-w-[480px] space-y-2 overflow-y-auto rounded-t-3xl bg-surface p-5" onClick={(e) => e.stopPropagation()}
        role="dialog" aria-label={t("label.layers")}>
        <h2 className="text-[1.4rem] font-bold">🗺️ {t("label.layers")}</h2>
        {ROWS.map((r) => (
          <div key={r.id}>
            <label className="flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-2xl bg-raised px-4">
              <span className="font-semibold"><span aria-hidden="true">{r.icon} </span>{t(r.key)}</span>
              <input type="checkbox" role="switch" checked={state.on[r.id]} onChange={() => toggle(r.id)} className={check} />
            </label>
            {state.on[r.id] && missing[r.id] && <p className="px-4 pt-1 text-[0.95rem] text-warn">{t("line.notAvailable")}</p>}
            {r.id === "heat" && state.on.heat && (
              <div className="space-y-1 px-4 pt-2">
                <div className="flex items-center gap-3">
                  <span className="w-20 text-[0.95rem] text-soft">{state.heatHour === null ? t("label.followClock") : t("fmt.atTime", { time: `${state.heatHour % 12 || 12}:00` })}</span>
                  {/* the night, 22:00 -> 06:00 */}
                  <input type="range" min={0} max={8} value={state.heatHour === null ? 4 : (state.heatHour + 2) % 24} aria-label={t("label.safetyHeat")}
                    onChange={(e) => set({ heatHour: (Number(e.target.value) + 22) % 24 })} className="flex-1 accent-accent" />
                  <button onClick={() => set({ heatHour: null })} aria-pressed={state.heatHour === null}
                    className="min-h-11 rounded-xl border border-edge px-3 text-[0.95rem] font-semibold">{t("label.followClock")}</button>
                </div>
                <div className="flex items-center gap-2 text-[0.9rem] text-soft">
                  <span>{t("label.safer")}</span>
                  <span className="h-2.5 flex-1 rounded-full" style={{ background: "linear-gradient(90deg, var(--color-good), var(--color-warn), var(--color-bad))" }} aria-hidden="true" />
                  <span>{t("label.lessSafe")}</span>
                </div>
              </div>
            )}
            {r.id === "help" && state.on.help && (
              <div className="flex flex-wrap gap-x-4 px-4 pt-1">
                <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className={check} checked={state.helpOpenOnly} onChange={() => set({ helpOpenOnly: !state.helpOpenOnly })} />{t("label.openOnly")}</label>
                <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className={check} checked={state.helpNotSure} onChange={() => set({ helpNotSure: !state.helpNotSure })} />{t("label.includeNotSure")}</label>
              </div>
            )}
          </div>
        ))}
        <button onClick={() => setMore(!more)} aria-expanded={more} className="min-h-11 font-semibold text-accent underline-offset-4 hover:underline">{t("label.more")}</button>
        {more && (
          <div className="space-y-2 rounded-2xl bg-raised p-4 text-[0.98rem]">
            {(["heat", "night"] as const).map((k) => (
              <label key={k} className="flex items-center gap-3">
                <span className="w-28 font-semibold">{t(k === "heat" ? "label.safetyHeat" : "label.nightLights")}</span>
                <input type="range" min={15} max={95} value={Math.round(state.strength[k] * 100)} aria-label={`${t("label.strength")} ${t(k === "heat" ? "label.safetyHeat" : "label.nightLights")}`}
                  onChange={(e) => set({ strength: { ...state.strength, [k]: Number(e.target.value) / 100 } })} className="flex-1 accent-accent" />
              </label>
            ))}
            {moon && <p><b>🌙 {t("label.moonLight")}:</b> {t(MOON[moon.level])}</p>}
            <p className="pt-1 font-semibold">{t("label.details")}</p>
            {lit !== null && <p className="text-soft">{t("fmt.detailLit", { n: lit })} {t("line.othersNotSure")}</p>}
            {nightDate && <p className="text-soft">{t("fmt.detailNight", { date: nightDate })}</p>}
            <p className="text-soft">{t("line.detailHeat")} {t("line.detailPractice")}</p>
            {weatherTime && <p className="text-soft">{t("fmt.detailWeather", { time: weatherTime })}</p>}
            <p className="text-soft">{t("line.detailMoon")}</p>
          </div>
        )}
        <QuietButton className="w-full" onClick={onClose}>{t("label.close")}</QuietButton>
      </div>
    </div>
  );
}

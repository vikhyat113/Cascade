import { Fragment } from "react";
import { useT } from "../copy";
import { Chevron, PLACE_ICON, SAFETY, STATE, STEP_ICON, TIMING } from "../components/icons";
import { BackButton, BigButton, Sheet } from "../components/ui";
import type { Option, Step } from "../types";
import { SheetFooter } from "./Home";

export function Steps({ steps }: { steps: Step[] }) {
  const { t } = useT();
  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-2" aria-label="steps">
      {steps.map((s, i) => (
        <Fragment key={i}>
          {i > 0 && <li aria-hidden="true" className="text-soft">→</li>}
          <li className="flex items-center gap-1 rounded-xl bg-raised px-2.5 py-1.5 text-[1.05rem] font-semibold" title={s.text}>
            <span aria-hidden="true">{STEP_ICON[s.icon]}</span>
            {s.line && <span>{s.line}</span>}
            <span className="sr-only">{s.text}</span>
            <span>{t("fmt.minutes", { n: s.minutes })}</span>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

export function WarningLine({ option, onBackup }: { option: Option; onBackup: (id: string) => void }) {
  const { t } = useT();
  const w = option.warning;
  const backup = w?.backup_option_id ?? (option.timing === "too_late" ? option.backup_option_id : null);
  if (!w && !backup) return null;
  return (
    <div className="mt-3 flex items-center gap-2 rounded-2xl border border-warn/50 bg-warn/10 px-3 py-2.5">
      {w && (
        <p className="flex-1 text-[1.02rem] font-semibold text-warn">
          <span aria-hidden="true">⚠️ </span>{w.text}
          {w.pill && <span className="ml-2 rounded-full border border-warn/60 px-2 py-0.5 text-[0.85rem]">{w.pill}</span>}
        </p>
      )}
      {!w && <span className="flex-1" />}
      {backup && (
        <button onClick={() => onBackup(backup)} className="min-h-11 shrink-0 rounded-xl bg-warn px-3 font-bold text-night">
          {t("label.backup")}
        </button>
      )}
    </div>
  );
}

export function Result({ options, shown, onTab, onBackup, onStart, onBack, showPlaces, setShowPlaces, starting, lateAlert, setLateAlert, showDemo, onDemo, onHeight }: {
  options: Option[]; shown: Option; onTab: (id: string) => void; onBackup: (id: string) => void; onStart: () => void;
  lateAlert: boolean; setLateAlert: (v: boolean) => void;
  onBack: () => void; showPlaces: boolean; setShowPlaces: (v: boolean) => void; starting: boolean;
  showDemo: boolean; onDemo: () => void; onHeight: (h: number) => void;
}) {
  const { t } = useT();
  const tabs = options.filter((o) => o.tab);
  const timing = shown.timing !== "none" ? TIMING[shown.timing] : null;
  const safety = SAFETY[shown.safety_level];
  return (
    <Sheet onHeight={onHeight}>
      <div className="flex items-center gap-1">
        <BackButton onClick={onBack} />
        <div className="flex flex-1 rounded-2xl bg-raised p-1" role="tablist">
          {tabs.map((o) => (
            <button key={o.id} role="tab" aria-selected={o.id === shown.id} onClick={() => onTab(o.id)}
              className={`min-h-11 flex-1 rounded-xl px-1 text-[0.98rem] font-semibold ${o.id === shown.id ? "bg-accent text-accent-ink" : "text-soft"}`}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {!shown.tab && <p className="mt-3 text-[1rem] font-bold uppercase tracking-wide text-warn">{shown.label}</p>}

      <p className="mt-3 text-[1.75rem] font-bold leading-tight">{shown.arrive_text}</p>
      {timing && (
        <p className={`mt-1 text-[1.15rem] font-semibold ${timing.color}`}>
          <span aria-hidden="true">{timing.icon} </span>{shown.timing_text}
          {shown.late_text && <span className="ml-2 font-normal text-soft">{shown.late_text}</span>}
        </p>
      )}

      <p className="mt-3 text-[1.05rem]">
        <span className={`font-bold ${safety.color}`}><span aria-hidden="true">{safety.icon} </span>{shown.safety_text}</span>
        <span className="text-soft"> · {shown.safety_reason}</span>
      </p>

      <div className="mt-3"><Steps steps={shown.steps} /></div>
      {shown.same_text && <p className="mt-2 text-[0.95rem] text-soft">{shown.same_text}</p>}

      <WarningLine option={shown} onBackup={onBackup} />

      {shown.timing !== "none" && (
        <label className="mt-3 flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-2xl bg-raised px-4">
          <span className="font-semibold">{t("line.tellIfLate")}</span>
          <input type="checkbox" role="switch" checked={lateAlert} onChange={(e) => setLateAlert(e.target.checked)} className="h-6 w-6 accent-accent" />
        </label>
      )}

      <div className="mt-4"><BigButton onClick={onStart} disabled={starting}>{t("label.start")}</BigButton></div>

      {shown.places.length > 0 && (
        <div className="mt-3">
          <button onClick={() => setShowPlaces(!showPlaces)} aria-expanded={showPlaces}
            className="flex min-h-11 items-center gap-1 font-semibold text-accent underline-offset-4 hover:underline">
            {t("line.placesOnWay")} <Chevron dir={showPlaces ? "up" : "down"} />
          </button>
          {showPlaces && (
            <ul className="mt-1 space-y-1.5">
              {shown.places.map((p) => (
                <li key={p.id} className="flex min-h-12 items-center gap-3 rounded-2xl bg-raised px-3">
                  <span aria-hidden="true" className="text-[1.3rem]">{PLACE_ICON[p.type] || "📍"}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold">{p.name}</span>
                  <span className="text-soft">{p.distance_text}</span>
                  <span className={`font-semibold ${STATE[p.state].color}`}>{p.state_text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <SheetFooter showDemo={showDemo} onDemo={onDemo} />
    </Sheet>
  );
}

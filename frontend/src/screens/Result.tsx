import { Fragment } from "react";
import { useT } from "../copy";
import { Icon } from "../components/Icon";
import { STEP_ICON, PLACE_ICON, SAFETY, STATE, TIMING } from "../components/icons";
import { BackButton, BigButton, Sheet } from "../components/ui";
import type { Option, Step } from "../types";
import { SheetFooter } from "./Home";

export function Steps({ steps }: { steps: Step[] }) {
  const { t } = useT();
  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-2" aria-label="steps">
      {steps.map((s, i) => {
        const iconName = STEP_ICON[s.icon] ?? "walk";
        return (
          <Fragment key={i}>
            {i > 0 && <li aria-hidden="true" className="text-soft">&#8594;</li>}
            <li className="flex items-center gap-1.5 rounded-[14px] bg-raised px-2.5 py-1.5 text-[0.95rem] font-semibold" title={s.text}>
              <Icon name={iconName} size={15} className="text-soft" />
              {s.line && <span>{s.line}</span>}
              <span className="sr-only">{s.text}</span>
              <span>{t("fmt.minutes", { n: s.minutes })}</span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

export function WarningLine({ option, onBackup }: { option: Option; onBackup: (id: string) => void }) {
  const { t } = useT();
  const w = option.warning;
  const backup = w?.backup_option_id ?? (option.timing === "too_late" ? option.backup_option_id : null);
  if (!w && !backup) return null;
  return (
    <div className="mt-3 flex items-center gap-2 rounded-[16px] border border-warn/50 bg-warn/10 px-3 py-2.5">
      {w && (
        <p className="flex-1 text-[0.95rem] font-semibold text-warn">
          <Icon name="alert-triangle" size={16} className="mr-1 inline" />
          {w.text}
          {w.pill && <span className="ml-2 rounded-full border border-warn/60 px-2 py-0.5 text-[0.8rem]">{w.pill}</span>}
        </p>
      )}
      {!w && <span className="flex-1" />}
      {backup && (
        <button onClick={() => onBackup(backup)} className="min-h-[44px] shrink-0 rounded-[14px] bg-warn px-3 font-bold text-night">
          {t("label.backup")}
        </button>
      )}
    </div>
  );
}

export function Result({
  options, shown, onTab, onBackup, onStart, onBack, onCompare, showPlaces, setShowPlaces, starting, showDemo, onDemo, onHeight,
}: {
  options: Option[]; shown: Option; onTab: (id: string) => void; onBackup: (id: string) => void; onStart: () => void;
  onBack: () => void; onCompare?: () => void; showPlaces: boolean; setShowPlaces: (v: boolean) => void; starting: boolean;
  showDemo: boolean; onDemo: () => void; onHeight: (h: number) => void;
}) {
  const { t } = useT();
  const tabs = options.filter((o) => o.tab);
  const timing = shown.timing !== "none" ? TIMING[shown.timing] : null;
  const safety = SAFETY[shown.safety_level];
  return (
    <Sheet onHeight={onHeight}>
      {/* Tabs */}
      <div className="flex items-center gap-1">
        <BackButton onClick={onBack} />
        <div className="flex flex-1 rounded-[20px] bg-raised p-1" role="tablist">
          {tabs.map((o) => (
            <button
              key={o.id}
              role="tab"
              aria-selected={o.id === shown.id}
              onClick={() => onTab(o.id)}
              className={`min-h-11 flex-1 rounded-[16px] px-1 text-[0.92rem] font-semibold transition-colors ${
                o.id === shown.id ? "bg-lime text-lime-ink shadow-sm" : "text-soft hover:text-ink"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {!shown.tab && (
        <p className="mt-3 text-[0.9rem] font-bold uppercase tracking-wide text-warn">{shown.label}</p>
      )}

      {/* Arrive text */}
      <p className="mt-3 text-[1.75rem] font-bold leading-tight">{shown.arrive_text}</p>

      {/* Timing */}
      {timing && (
        <p className={`mt-1 text-[1.0rem] font-semibold ${timing.color} flex items-center gap-1.5`}>
          <Icon name={timing.iconName} size={17} />
          {shown.timing_text}
          {shown.late_text && <span className="ml-2 font-normal text-soft">{shown.late_text}</span>}
        </p>
      )}

      {/* Safety */}
      <p className="mt-2 flex items-center gap-1.5 text-[1.0rem]">
        <Icon name={safety.iconName} size={17} className={safety.color} />
        <span className={`font-bold ${safety.color}`}>{shown.safety_text}</span>
        <span className="text-soft">· {shown.safety_reason}</span>
      </p>

      {/* Steps */}
      <div className="mt-3"><Steps steps={shown.steps} /></div>
      {shown.same_text && <p className="mt-2 text-[0.9rem] text-soft">{shown.same_text}</p>}

      <WarningLine option={shown} onBackup={onBackup} />

      {/* Actions */}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <div className="flex-1">
          <BigButton onClick={onStart} disabled={starting}>{t("label.start")}</BigButton>
        </div>
        {onCompare && (
          <button
            onClick={onCompare}
            className="flex min-h-12 items-center justify-center gap-2 rounded-[20px] border border-edge bg-raised px-4 text-[0.92rem] font-semibold text-ink transition-colors hover:border-lime/30"
          >
            <Icon name="route-fork" size={16} />
            {t("label.compareWays")}
          </button>
        )}
      </div>

      {/* Places on way */}
      {shown.places.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setShowPlaces(!showPlaces)}
            aria-expanded={showPlaces}
            className="flex min-h-[44px] items-center gap-1.5 font-semibold text-lime underline-offset-4 hover:underline text-[0.9rem]"
          >
            {t("line.placesOnWay")}
            <Icon name={showPlaces ? "chevron-up" : "chevron-down"} size={16} />
          </button>
          {showPlaces && (
            <ul className="mt-1 space-y-1.5">
              {shown.places.map((p) => {
                const iconName = PLACE_ICON[p.type] ?? "landmark";
                const stateInfo = STATE[p.state];
                return (
                  <li key={p.id} className="flex min-h-12 items-center gap-3 rounded-[16px] bg-raised px-3">
                    <Icon name={iconName} size={20} className="text-soft shrink-0" />
                    <span className="min-w-0 flex-1 truncate font-semibold">{p.name}</span>
                    <span className="text-soft text-[0.85rem]">{p.distance_text}</span>
                    <span className={`font-semibold text-[0.85rem] ${stateInfo.color} flex items-center gap-1`}>
                      <Icon name={stateInfo.iconName} size={14} />
                      {p.state_text}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      <SheetFooter showDemo={showDemo} onDemo={onDemo} />
    </Sheet>
  );
}

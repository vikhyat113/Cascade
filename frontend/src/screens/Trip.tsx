import { useEffect, useState } from "react";
import { api } from "../api";
import { useT } from "../copy";
import { Icon } from "../components/Icon";
import { PLACE_ICON, STATE, STEP_ICON } from "../components/icons";
import { BigButton, QuietButton, Sheet } from "../components/ui";
import type { Option, Place, PlaceOnWay, Trip as TripState } from "../types";
import { SheetFooter } from "./Home";
import { WarningLine } from "./Result";

/** Trip screen: countdown, next step card, progress bar, SOS, share. Restyled. */
export function Trip({
  option, trip, onHelp, onEnd, onBackup, showDemo, onDemo, onHeight,
}: {
  option: Option; trip: TripState | null; onHelp: () => void; onEnd: () => void; onBackup: (id: string) => void;
  showDemo: boolean; onDemo: () => void; onHeight: (h: number) => void;
}) {
  const { t } = useT();
  const pct = Math.round((trip?.progress ?? 0) * 100);
  const nextIconName = STEP_ICON[trip?.next_icon || "walk"] ?? "walk";
  return (
    <>
      {/* Floating next-step card */}
      <div className="fixed inset-x-0 top-16 z-20 flex justify-center px-4">
        <div
          className="flex w-full max-w-[480px] items-center gap-3 rounded-[24px] border border-edge bg-surface px-4 py-3 shadow-xl"
          aria-live="polite"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-raised text-lime">
            <Icon name={nextIconName} size={22} />
          </span>
          <p className="text-[1.4rem] font-bold leading-tight">{trip?.next_text}</p>
        </div>
      </div>

      <Sheet onHeight={onHeight}>
        <p className="text-[1.75rem] font-bold leading-tight">{option.arrive_text}</p>

        {/* Progress bar */}
        <div
          className="mt-3 h-2 w-full overflow-hidden rounded-full bg-raised"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-lime transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>

        <WarningLine option={option} onBackup={onBackup} />

        {/* SOS */}
        <div className="mt-4">
          <BigButton tone="help" onClick={onHelp} label={t("label.help")}>
            <Icon name="sos" size={20} />
            {t("label.help")}
          </BigButton>
        </div>
        <div className="mt-2.5">
          <QuietButton className="w-full" onClick={onEnd}>{t("label.endTrip")}</QuietButton>
        </div>

        <SheetFooter showDemo={showDemo} onDemo={onDemo} />
      </Sheet>
    </>
  );
}

/** Help sheet: SOS, nearest hospital/police, share. */
export function HelpSheet({
  at, planId, onClose, onGo,
}: {
  at: Place; planId: string | null; onClose: () => void; onGo: (p: PlaceOnWay) => void;
}) {
  const { t, lang } = useT();
  const [near, setNear] = useState<{ hospital: PlaceOnWay | null; police: PlaceOnWay | null } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.sos(at, lang).then(setNear).catch(() => setNear({ hospital: null, police: null }));
  }, [at, lang]);

  const row = (label: string, p: PlaceOnWay | null | undefined) => {
    const stateInfo = p ? STATE[p.state] : null;
    const iconName = p ? (PLACE_ICON[p.type] ?? "hospital") : "hospital";
    return (
      <div className="rounded-[16px] bg-raised p-3">
        <p className="text-[0.85rem] font-semibold text-soft">{label}</p>
        {p ? (
          <div className="mt-1.5 flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface text-soft">
              <Icon name={iconName} size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[1.05rem] font-bold">{p.name}</p>
              <p className="text-[0.85rem] text-soft flex items-center gap-1">
                {p.minutes_text}
                {stateInfo && (
                  <>
                    <span>·</span>
                    <Icon name={stateInfo.iconName} size={13} className={stateInfo.color} />
                    <span className={stateInfo.color}>{p.state_text}</span>
                  </>
                )}
              </p>
            </div>
            <button
              onClick={() => onGo(p)}
              className="min-h-[44px] rounded-[14px] bg-lime px-4 font-bold text-lime-ink text-[0.9rem]"
            >
              {t("label.go")}
            </button>
          </div>
        ) : (
          <p className="mt-1 text-soft text-[0.9rem]">{near ? t("line.nothingOpen") : "…"}</p>
        )}
      </div>
    );
  };

  const share = async () => {
    if (!planId) return;
    try {
      const r = await api.share(planId);
      await navigator.clipboard?.writeText(`${window.location.origin}${r.url}`);
    } catch { /* clipboard blocked */ }
    setCopied(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-[480px] space-y-2.5 rounded-t-[28px] bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("label.help")}
      >
        <div className="flex items-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-help/20 text-help">
            <Icon name="sos" size={22} />
          </div>
          <h2 className="text-[1.3rem] font-bold">{t("label.help")}</h2>
        </div>

        <a
          href="tel:112"
          className="flex min-h-14 w-full items-center justify-center gap-2 rounded-[20px] bg-help text-[1.15rem] font-bold text-white"
        >
          <Icon name="sos" size={20} />
          {t("label.call112")}
        </a>

        {row(t("label.nearestHospital"), near?.hospital)}
        {row(t("label.nearestPolice"), near?.police)}

        {planId && (
          <QuietButton className="w-full" onClick={share}>
            <Icon name="share" size={17} />
            {copied ? t("line.linkCopied") : t("label.shareTrip")}
          </QuietButton>
        )}
        <QuietButton className="w-full" onClick={onClose}>
          <Icon name="close" size={17} />
          {t("label.close")}
        </QuietButton>
      </div>
    </div>
  );
}

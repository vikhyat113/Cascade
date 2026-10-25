import { useEffect, useState } from "react";
import { api } from "../api";
import { useT } from "../copy";
import { PLACE_ICON, STATE, STEP_ICON } from "../components/icons";
import { BigButton, QuietButton, Sheet } from "../components/ui";
import type { Option, Place, PlaceOnWay, Trip as TripState } from "../types";
import { SheetFooter } from "./Home";
import { WarningLine } from "./Result";

/** Screen 3: one huge next step, "Home by", a thin progress bar, and Help always visible. */
export function Trip({ option, trip, onHelp, onEnd, onBackup, showDemo, onDemo, onHeight }: {
  option: Option; trip: TripState | null; onHelp: () => void; onEnd: () => void; onBackup: (id: string) => void;
  showDemo: boolean; onDemo: () => void; onHeight: (h: number) => void;
}) {
  const { t } = useT();
  const pct = Math.round((trip?.progress ?? 0) * 100);
  return (
    <>
      <div className="fixed inset-x-0 top-14 z-20 flex justify-center px-3">
        <div className="flex w-full max-w-[480px] items-center gap-3 rounded-3xl border border-edge bg-surface px-4 py-3 shadow-xl" aria-live="polite">
          <span className="text-[2.2rem]" aria-hidden="true">{STEP_ICON[trip?.next_icon || "walk"]}</span>
          <p className="text-[1.6rem] font-bold leading-tight">{trip?.next_text}</p>
        </div>
      </div>
      <Sheet onHeight={onHeight}>
        <p className="text-[1.75rem] font-bold leading-tight">{option.arrive_text}</p>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
        <WarningLine option={option} onBackup={onBackup} />
        <div className="mt-4"><BigButton tone="help" onClick={onHelp}>🆘 {t("label.help")}</BigButton></div>
        <div className="mt-2.5"><QuietButton className="w-full" onClick={onEnd}>{t("label.endTrip")}</QuietButton></div>
        <SheetFooter showDemo={showDemo} onDemo={onDemo} />
      </Sheet>
    </>
  );
}

/** Help: Call 112, nearest hospital / police (with a way there), share the trip. */
export function HelpSheet({ at, planId, onClose, onGo }: { at: Place; planId: string | null; onClose: () => void; onGo: (p: PlaceOnWay) => void }) {
  const { t, lang } = useT();
  const [near, setNear] = useState<{ hospital: PlaceOnWay | null; police: PlaceOnWay | null } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api.sos(at, lang).then(setNear).catch(() => setNear({ hospital: null, police: null }));
  }, [at, lang]);
  const row = (label: string, p: PlaceOnWay | null | undefined) => (
    <div className="rounded-2xl bg-raised p-3">
      <p className="text-[0.95rem] font-semibold text-soft">{label}</p>
      {p ? (
        <div className="mt-1 flex items-center gap-3">
          <span aria-hidden="true" className="text-[1.5rem]">{PLACE_ICON[p.type]}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[1.1rem] font-bold">{p.name}</p>
            <p className="text-soft">{p.minutes_text} · <span className={STATE[p.state].color}>{p.state_text}</span></p>
          </div>
          <button onClick={() => onGo(p)} className="min-h-12 rounded-xl bg-accent px-4 font-bold text-accent-ink">{t("label.go")}</button>
        </div>
      ) : <p className="mt-1 text-soft">{near ? t("line.nothingOpen") : "…"}</p>}
    </div>
  );
  const share = async () => {
    if (!planId) return;
    try {
      const r = await api.share(planId);
      await navigator.clipboard?.writeText(`${window.location.origin}${r.url}`);
    } catch { /* clipboard blocked: still say it is only a demo */ }
    setCopied(true);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-[480px] space-y-2.5 rounded-t-3xl bg-surface p-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("label.help")}>
        <h2 className="text-[1.4rem] font-bold">🆘 {t("label.help")}</h2>
        <a href="tel:112" className="flex min-h-14 w-full items-center justify-center rounded-2xl bg-help text-[1.25rem] font-bold text-white">📞 {t("label.call112")}</a>
        {row(t("label.nearestHospital"), near?.hospital)}
        {row(t("label.nearestPolice"), near?.police)}
        {planId && <QuietButton className="w-full" onClick={share}>🔗 {copied ? t("line.linkCopied") : t("label.shareTrip")}</QuietButton>}
        <QuietButton className="w-full" onClick={onClose}>{t("label.close")}</QuietButton>
      </div>
    </div>
  );
}

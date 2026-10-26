import { useT } from "../copy";
import { STEP_ICON } from "../components/icons";
import { BigButton, QuietButton, Sheet } from "../components/ui";
import type { Option, Trip as TripState } from "../types";
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
      <div className="fixed inset-x-0 top-[5rem] z-20 flex justify-center px-3">
        <div className="flex w-full max-w-[480px] items-center gap-3 rounded-3xl border border-edge bg-surface px-4 py-3 shadow-xl" aria-live="polite">
          <span className="min-w-[3rem] text-center text-[1rem] font-bold text-accent bg-raised rounded-xl px-2 py-1" aria-hidden="true">{STEP_ICON[trip?.next_icon || "walk"]}</span>
          <p className="text-[1.6rem] font-bold leading-tight">{trip?.next_text}</p>
        </div>
      </div>
      <Sheet onHeight={onHeight}>
        <p className="text-[1.75rem] font-bold leading-tight">{option.arrive_text}</p>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
        {!trip?.arrived && <WarningLine option={option} onBackup={onBackup} />}
        <div className="mt-4"><BigButton tone="help" onClick={onHelp}>{t("label.help")}</BigButton></div>
        <div className="mt-2.5"><QuietButton className="w-full" onClick={onEnd}>{t("label.endTrip")}</QuietButton></div>
        <SheetFooter showDemo={showDemo} onDemo={onDemo} />
      </Sheet>
    </>
  );
}

import { useT } from "../copy";
import { SAFETY } from "../components/icons";
import { QuietButton } from "../components/ui";
import type { OtherWay } from "../engine/simpleView";

/** Colours for the ways on the map (from the theme, in the order the sheet lists them). */
export const WAY_COLORS = ["accent", "good", "warn", "me"] as const;

/** "Other ways" (UPGRADE §4): up to 4 ways with arrival, safety, minutes outside and a one-line why. */
export function OtherWays({ ways, closeText, colors, onPick, onClose }: {
  ways: OtherWay[]; closeText: string | null; colors: string[]; onPick: (optionId: string) => void; onClose: () => void;
}) {
  const { t } = useT();
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 flex justify-center">
      <div className="scroll-quiet max-h-[60dvh] w-full max-w-[480px] space-y-2 overflow-y-auto rounded-t-3xl border-t border-edge bg-surface p-5 shadow-xl"
        role="dialog" aria-label={t("label.otherWays")}>
        <h2 className="text-[1.3rem] font-bold">{t("label.otherWays")}</h2>
        {closeText && <p className="font-semibold text-warn">{closeText}</p>}
        {ways.map((w, i) => {
          const s = SAFETY[w.safety_level];
          return (
            <button key={w.option_id} onClick={() => onPick(w.option_id)}
              className="flex w-full items-start gap-3 rounded-2xl border border-edge bg-raised p-3 text-left">
              <span aria-hidden="true" className="mt-1.5 h-3 w-8 shrink-0 rounded-full" style={{ background: colors[i % colors.length] }} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[1.1rem] font-bold">{w.arrive_text}</span>
                  {w.best && <span className="rounded-full border border-accent px-2 text-[0.85rem] font-semibold text-accent">{t("label.bestPick")}</span>}
                </span>
                <span className="block text-[0.98rem]"><span className={`font-semibold ${s.color}`}><span aria-hidden="true">{s.icon} </span>{w.safety_text}</span>
                  <span className="text-soft"> · {w.outside_text}</span></span>
                <span className="block text-[0.95rem] text-soft">{w.why_text}</span>
              </span>
            </button>
          );
        })}
        <QuietButton className="w-full" onClick={onClose}>{t("label.close")}</QuietButton>
      </div>
    </div>
  );
}

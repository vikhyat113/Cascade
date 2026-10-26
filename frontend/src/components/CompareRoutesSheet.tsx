import { useState, useMemo } from "react";
import { useT } from "../copy";
import { Chevron } from "./icons";
import type { RouteItem } from "../types";

interface Props {
  routes: RouteItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  showDominated: boolean;
  onToggleDominated: (v: boolean) => void;
  tieNote?: string | null;
}

export function CompareRoutesSheet({
  routes,
  selectedId,
  onSelect,
  onClose,
  showDominated,
  onToggleDominated,
  tieNote,
}: Props) {
  const { t } = useT();
  const [safetyWeight, setSafetyWeight] = useState<number>(0.7); // 0 = speed, 1 = safety
  const [expandDetails, setExpandDetails] = useState<boolean>(false);

  // Compute winning metric highlights across non-dominated / all routes
  const highlights = useMemo(() => {
    if (!routes || routes.length === 0) return { bestTimeId: null, bestSafetyId: null, bestOutdoorId: null, bestUnlitId: null };
    const candidates = routes.filter((r) => !r.dominated || showDominated);
    if (candidates.length === 0) return { bestTimeId: null, bestSafetyId: null, bestOutdoorId: null, bestUnlitId: null };

    let bestTime = Infinity;
    let bestTimeId: string | null = null;
    let bestSafety = -1;
    let bestSafetyId: string | null = null;
    let bestOutdoor = Infinity;
    let bestOutdoorId: string | null = null;
    let bestUnlit = Infinity;
    let bestUnlitId: string | null = null;

    for (const r of candidates) {
      const expTime = r.metrics.duration_min.expected ?? 999;
      if (expTime < bestTime) {
        bestTime = expTime;
        bestTimeId = r.id;
      }
      const safeLo = r.metrics.safety.lo;
      if (safeLo > bestSafety) {
        bestSafety = safeLo;
        bestSafetyId = r.id;
      }
      const outMin = r.metrics.outdoor_min;
      if (outMin < bestOutdoor) {
        bestOutdoor = outMin;
        bestOutdoorId = r.id;
      }
      const unk = r.metrics.unknown_lighting_share;
      if (unk < bestUnlit) {
        bestUnlit = unk;
        bestUnlitId = r.id;
      }
    }

    return { bestTimeId, bestSafetyId, bestOutdoorId, bestUnlitId };
  }, [routes, showDominated]);

  // Live re-ranking based on Safety vs Speed slider
  const rankedRoutes = useMemo(() => {
    if (!routes) return [];
    const wSafe = 0.15 + 0.55 * safetyWeight;
    const wSpeed = 0.55 * (1 - safetyWeight) + 0.15;
    const wOther = 0.15;

    // Normalizing ranges
    const times = routes.map((r) => r.metrics.duration_min.expected ?? 999);
    const safeties = routes.map((r) => r.metrics.safety.lo);
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const minSafe = Math.min(...safeties);
    const maxSafe = Math.max(...safeties);

    return [...routes]
      .filter((r) => !r.dominated || showDominated)
      .map((r) => {
        const tVal = r.metrics.duration_min.expected ?? 999;
        const normTime = maxTime > minTime ? (maxTime - tVal) / (maxTime - minTime) : 1;
        const normSafe = maxSafe > minSafe ? (r.metrics.safety.lo - minSafe) / (maxSafe - minSafe) : 1;
        const dynamicScore = wSafe * normSafe + wSpeed * normTime + wOther * (1 - r.metrics.unknown_lighting_share);
        return { ...r, dynamicScore };
      })
      .sort((a, b) => b.dynamicScore - a.dynamicScore);
  }, [routes, safetyWeight, showDominated]);

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88vh] flex-col rounded-t-3xl border-t border-edge bg-surface shadow-2xl backdrop-blur-xl animate-in slide-in-from-bottom duration-300 md:inset-x-auto md:left-4 md:bottom-4 md:w-[460px] md:rounded-3xl md:border"
      role="dialog"
      aria-labelledby="compare-title"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-edge/60 px-5 py-4">
        <div>
          <h2 id="compare-title" className="text-[1.3rem] font-bold text-ink">
            {t("label.compareWays")}
          </h2>
          {tieNote && (
            <p className="mt-0.5 text-[0.82rem] font-medium text-warn">
              {tieNote}
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-2xl bg-raised text-[1.2rem] font-bold text-soft hover:bg-edge hover:text-ink"
          aria-label={t("label.close")}
        >
          ✕
        </button>
      </div>

      {/* Controls: Safety vs speed slider & Dominated toggle */}
      <div className="space-y-3.5 border-b border-edge/60 bg-raised/40 px-5 py-3.5">
        <div>
          <div className="flex items-center justify-between text-[0.88rem] font-semibold">
            <span className="text-soft">{t("label.fastest")}</span>
            <span className="text-accent">{t("label.safetySpeed")}</span>
            <span className="text-soft">{t("label.safest")}</span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={safetyWeight}
            onChange={(e) => setSafetyWeight(parseFloat(e.target.value))}
            className="mt-1.5 h-2 w-full cursor-pointer appearance-none rounded-lg bg-edge accent-accent"
            aria-label={t("label.safetySpeed")}
          />
        </div>

        <label className="flex cursor-pointer items-center justify-between text-[0.88rem] font-medium text-soft">
          <span>{t("label.showDominated")}</span>
          <input
            type="checkbox"
            checked={showDominated}
            onChange={(e) => onToggleDominated(e.target.checked)}
            className="h-5 w-5 rounded border-edge accent-accent"
          />
        </label>
      </div>

      {/* Routes List */}
      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {rankedRoutes.map((r) => {
          const isSelected = selectedId ? r.id === selectedId : r.recommended;
          const isWinnerTime = r.id === highlights.bestTimeId;
          const isWinnerSafe = r.id === highlights.bestSafetyId;
          const isWinnerOutdoor = r.id === highlights.bestOutdoorId;
          const isWinnerUnlit = r.id === highlights.bestUnlitId;

          return (
            <div
              key={r.id}
              onClick={() => onSelect(r.id)}
              className={`cursor-pointer rounded-2xl border p-4 transition-all ${
                isSelected
                  ? "border-accent bg-accent/10 shadow-md ring-1 ring-accent"
                  : r.dominated
                  ? "border-dashed border-edge/80 bg-raised/20 opacity-75 hover:opacity-100"
                  : "border-edge bg-raised hover:border-accent/40"
              }`}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
            >
              {/* Card Header */}
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[1.05rem] font-bold text-ink">
                      {r.label}
                    </span>
                    <span className="text-[0.88rem] font-medium text-soft">
                      · {r.title}
                    </span>
                    {r.recommended && (
                      <span className="rounded-full bg-accent px-2 py-0.5 text-[0.72rem] font-bold uppercase tracking-wide text-accent-ink">
                        {t("label.recommended")}
                      </span>
                    )}
                    {r.dominated && (
                      <span className="rounded-full bg-edge px-2 py-0.5 text-[0.72rem] font-semibold text-soft">
                        Dominated
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[0.75rem] font-bold ${
                      r.infeasible_worst
                        ? "bg-warn/20 text-warn"
                        : "bg-emerald-500/15 text-emerald-400"
                    }`}
                  >
                    {r.infeasible_worst ? t("label.couldBeLate") : t("label.onTime")}
                  </span>
                </div>
              </div>

              {/* Metrics Grid */}
              <div className="mt-3 grid grid-cols-2 gap-2 text-[0.86rem] sm:grid-cols-4">
                {/* Time */}
                <div
                  className={`rounded-xl px-2.5 py-1.5 ${
                    isWinnerTime ? "bg-emerald-500/15 font-semibold text-emerald-300 ring-1 ring-emerald-500/40" : "bg-surface/50 text-soft"
                  }`}
                >
                  <div className="text-[0.72rem] uppercase tracking-wider text-soft">Time</div>
                  <div className="text-[0.98rem] font-bold text-ink">
                    {r.metrics.duration_min.best ?? "–"}–{r.metrics.duration_min.worst ?? "–"} min
                  </div>
                </div>

                {/* Safety */}
                <div
                  className={`rounded-xl px-2.5 py-1.5 ${
                    isWinnerSafe ? "bg-accent/20 font-semibold text-accent ring-1 ring-accent/40" : "bg-surface/50 text-soft"
                  }`}
                >
                  <div className="text-[0.72rem] uppercase tracking-wider text-soft">Safety</div>
                  <div className="text-[0.98rem] font-bold text-ink">
                    {r.metrics.safety.lo}–{r.metrics.safety.hi}
                  </div>
                </div>

                {/* Outdoors */}
                <div
                  className={`rounded-xl px-2.5 py-1.5 ${
                    isWinnerOutdoor ? "bg-emerald-500/15 font-semibold text-emerald-300 ring-1 ring-emerald-500/40" : "bg-surface/50 text-soft"
                  }`}
                >
                  <div className="text-[0.72rem] uppercase tracking-wider text-soft">{t("label.outdoorTime")}</div>
                  <div className="text-[0.98rem] font-bold text-ink">
                    {r.metrics.outdoor_min} min
                  </div>
                </div>

                {/* Unlit */}
                <div
                  className={`rounded-xl px-2.5 py-1.5 ${
                    isWinnerUnlit ? "bg-emerald-500/15 font-semibold text-emerald-300 ring-1 ring-emerald-500/40" : "bg-surface/50 text-soft"
                  }`}
                >
                  <div className="text-[0.72rem] uppercase tracking-wider text-soft">{t("label.unlitStreets")}</div>
                  <div className="text-[0.98rem] font-bold text-ink">
                    {Math.round(r.metrics.unknown_lighting_share * 100)}%
                  </div>
                </div>
              </div>

              {/* One-line Why or Loss Reason */}
              <p className="mt-2.5 text-[0.84rem] leading-relaxed text-soft">
                {r.recommended ? (
                  <span>
                    <strong className="text-ink">Why chosen: </strong>
                    {r.why}
                  </span>
                ) : (
                  <span>{r.loss_reason || r.why}</span>
                )}
              </p>
            </div>
          );
        })}

        {/* Expandable "How choices compare" */}
        <div className="mt-4 rounded-2xl border border-edge bg-raised/60 p-3.5">
          <button
            onClick={() => setExpandDetails(!expandDetails)}
            className="flex w-full items-center justify-between font-semibold text-accent"
            aria-expanded={expandDetails}
          >
            <span>{t("label.howWeCompared")}</span>
            <Chevron dir={expandDetails ? "up" : "down"} />
          </button>

          {expandDetails && (
            <div className="mt-3 space-y-2.5 text-[0.82rem] text-soft">
              <p>
                Each choice is checked for deadline buffer, safety range, outdoor exposure,
                and unlit stretches. No values are invented across missing data.
              </p>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-[0.8rem]">
                  <thead>
                    <tr className="border-b border-edge text-ink">
                      <th className="pb-1">Way</th>
                      <th className="pb-1">Safety</th>
                      <th className="pb-1">Time</th>
                      <th className="pb-1">Indoors</th>
                      <th className="pb-1">Lighting</th>
                      <th className="pb-1 font-bold">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge/40">
                    {rankedRoutes.map((r) => (
                      <tr key={r.id}>
                        <td className="py-1 font-semibold text-ink">{r.label}</td>
                        <td className="py-1">{r.score_breakdown?.safety_score ?? "–"}</td>
                        <td className="py-1">{r.score_breakdown?.timing_score ?? "–"}</td>
                        <td className="py-1">{r.score_breakdown?.indoor_score ?? "–"}</td>
                        <td className="py-1">{r.score_breakdown?.lighting_score ?? "–"}</td>
                        <td className="py-1 font-bold text-accent">{r.score_breakdown?.total ?? "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

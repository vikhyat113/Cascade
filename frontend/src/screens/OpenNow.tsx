import { useT, type CopyKey } from "../copy";
import { Icon } from "../components/Icon";
import { PLACE_ICON, STATE } from "../components/icons";
import { BackButton, Sheet } from "../components/ui";
import type { PlaceOnWay } from "../types";
import { NEEDS } from "./Home";

/** Screen 4: up to 5 places with name, distance, walking minutes and hours state. Restyled. */
export function OpenNow({
  title,
  currentType,
  places,
  empty,
  onBack,
  onPick,
  onSwitchNeed,
  onHeight,
}: {
  title: string;
  currentType?: string;
  places: PlaceOnWay[] | null;
  empty: string | null;
  onBack: () => void;
  onPick: (p: PlaceOnWay) => void;
  onSwitchNeed?: (type: string) => void;
  onHeight: (h: number) => void;
}) {
  const { t } = useT();
  return (
    <Sheet onHeight={onHeight}>
      {/* Header */}
      <div className="flex items-center gap-2">
        <BackButton onClick={onBack} />
        <h1 className="text-[1.3rem] font-bold">
          {title} <span className="text-soft font-semibold">· {t("label.openNow")}</span>
        </h1>
      </div>

      {/* Category filter tabs */}
      {onSwitchNeed && (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1 scroll-quiet" role="tablist" aria-label="Facility Categories">
          {NEEDS.map((n) => {
            const active = currentType === n.type;
            return (
              <button
                key={n.type}
                id={`tab-${n.type}`}
                onClick={() => onSwitchNeed(n.type)}
                aria-pressed={active}
                className={`flex min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-4 py-1 text-[0.85rem] font-bold transition-colors ${
                  active
                    ? "border-lime/60 bg-lime text-lime-ink shadow"
                    : "border-edge bg-raised text-soft hover:text-ink"
                }`}
              >
                <Icon name={n.iconName} size={16} />
                {t(n.key as CopyKey)}
              </button>
            );
          })}
        </div>
      )}

      {/* States */}
      {places === null && (
        <p className="mt-4 text-[1.0rem] text-soft">{t("line.finding")}</p>
      )}
      {places?.length === 0 && (
        <p className="mt-4 text-[1.0rem] text-warn">{empty || t("line.nothingOpen")}</p>
      )}

      {/* Results */}
      <ul className="mt-3 space-y-2">
        {(places || []).slice(0, 5).map((p) => {
          const iconName = PLACE_ICON[p.type] ?? "landmark";
          const stateInfo = STATE[p.state];
          return (
            <li key={p.id}>
              <button
                onClick={() => onPick(p)}
                className="flex min-h-[64px] w-full items-center gap-3 rounded-[20px] bg-raised px-4 text-left transition-colors hover:border hover:border-lime/20"
              >
                {/* Icon with hours-state ring */}
                <span
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 ${
                    p.state === "open"
                      ? "border-good/60 bg-good/10 text-good"
                      : p.state === "maybe_open"
                        ? "border-warn/60 bg-warn/10 text-warn"
                        : "border-edge bg-surface text-soft"
                  }`}
                >
                  <Icon name={iconName} size={20} />
                </span>

                {/* Name + distance */}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[1.0rem] font-bold">{p.name}</span>
                  <span className="block text-[0.82rem] text-soft">
                    {p.distance_text}
                    {p.minutes_text && ` · ${p.minutes_text}`}
                  </span>
                </span>

                {/* Hours state */}
                <span className={`shrink-0 flex items-center gap-1 font-semibold text-[0.82rem] ${stateInfo.color}`}>
                  <Icon name={stateInfo.iconName} size={14} />
                  {p.state_text}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

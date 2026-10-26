import { useT } from "../copy";
import { PLACE_ICON, STATE, PinIcon } from "../components/icons";
import { BackButton, Sheet } from "../components/ui";
import type { PlaceOnWay } from "../types";

/** Screen 4: up to 5 places with name, distance, walking minutes and Open / Maybe open / Not sure. */
export function OpenNow({ title, places, empty, onBack, onPick, onHeight }: {
  title: string; places: PlaceOnWay[] | null; empty: string | null; onBack: () => void;
  onPick: (p: PlaceOnWay) => void; onHeight: (h: number) => void;
}) {
  const { t } = useT();
  return (
    <Sheet onHeight={onHeight}>
      <div className="flex items-center gap-2">
        <BackButton onClick={onBack} />
        <h1 className="text-[1.4rem] font-bold">{title} · {t("label.openNow")}</h1>
      </div>
      {places === null && <p className="mt-3 text-[1.1rem] text-soft">{t("line.finding")}</p>}
      {places?.length === 0 && <p className="mt-3 text-[1.1rem] text-warn">{empty || t("line.nothingOpen")}</p>}
      <ul className="mt-2 space-y-2">
        {(places || []).slice(0, 5).map((p) => (
          <li key={p.id}>
            <button onClick={() => onPick(p)} className="flex min-h-16 w-full items-center gap-3 rounded-2xl bg-raised px-3 text-left">
              <span aria-hidden="true" className="text-[1.6rem] text-soft">{PLACE_ICON[p.type] || <PinIcon />}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[1.1rem] font-bold">{p.name}</span>
                <span className="block text-soft">{p.distance_text} · {p.minutes_text}</span>
              </span>
              <span className={`shrink-0 font-bold ${STATE[p.state].color}`}>
                <span aria-hidden="true">{STATE[p.state].icon} </span>{p.state_text}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

import { useEffect, useRef, useState } from "react";
import { useT } from "../copy";
import { call } from "../lib/engine";
import { BackButton, Sheet } from "../components/ui";
import type { Place } from "../types";

/** Choose a place: type it, or pick it on the map. For "To", the choice can also be saved as Home / Work. */
export function Search({ field, onBack, onChoose, onPickMap, onHeight }: {
  field: "from" | "to"; onBack: () => void; onChoose: (p: Place, save: "home" | "work" | null) => void;
  onPickMap: (save: "home" | "work" | null) => void; onHeight: (h: number) => void;
}) {
  const { t } = useT();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ name: string; lat: number; lon: number }[] | null>(null);
  const [save, setSave] = useState<"home" | "work" | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (q.trim().length < 2) { setHits(null); return; }
    timer.current = window.setTimeout(() => call("geocode", q).then(setHits).catch(() => setHits([])), 200);
  }, [q]);

  return (
    <Sheet onHeight={onHeight}>
      <div className="flex items-center gap-2">
        <BackButton onClick={onBack} />
        <h1 className="text-[1.4rem] font-bold">{field === "from" ? t("label.from") : t("label.to")}</h1>
      </div>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("line.searchHint")} aria-label={t("line.searchHint")}
        className="mt-2 min-h-14 w-full rounded-2xl border border-edge bg-raised px-4 text-[1.15rem] text-ink placeholder:text-soft" />
      {field === "to" && (
        <div className="mt-2.5 flex gap-2">
          {(["home", "work"] as const).map((slot) => (
            <button key={slot} onClick={() => setSave(save === slot ? null : slot)} aria-pressed={save === slot}
              className={`min-h-11 rounded-full border px-4 font-semibold ${save === slot ? "border-accent bg-accent/15" : "border-edge bg-raised"}`}>
              {slot === "home" ? `⌂ ${t("label.setHome")}` : `💼 ${t("label.setWork")}`}
            </button>
          ))}
        </div>
      )}
      <ul className="mt-3 space-y-1.5">
        {(hits || []).map((h, i) => (
          <li key={i}>
            <button onClick={() => onChoose({ lat: h.lat, lon: h.lon, name: h.name, kind: save }, save)}
              className="flex min-h-14 w-full items-center rounded-2xl px-4 text-left text-[1.1rem] font-semibold hover:bg-raised">
              {h.name}
            </button>
          </li>
        ))}
      </ul>
      {hits && hits.length === 0 && <p className="mt-2 text-[1.05rem] text-warn">{t("line.noResults")}</p>}
      <button onClick={() => onPickMap(save)} className="mt-3 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl border border-edge bg-raised font-semibold">
        📍 {t("label.pickOnMap")}
      </button>
    </Sheet>
  );
}

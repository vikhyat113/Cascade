import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useT } from "../copy";
import { Icon } from "../components/Icon";
import { BackButton } from "../components/ui";
import type { Place } from "../types";

/** Full-screen place picker — no emoji. */
export function Search({
  field,
  onBack,
  onChoose,
  onPickMap,
  onHeight,
}: {
  field: "from" | "to";
  onBack: () => void;
  onChoose: (p: Place, save: "home" | "work" | null) => void;
  onPickMap: (save: "home" | "work" | null) => void;
  onHeight: (h: number) => void;
}) {
  const { t } = useT();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ name: string; lat: number; lon: number }[] | null>(null);
  const [save, setSave] = useState<"home" | "work" | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (q.trim().length < 2) { setHits(null); return; }
    timer.current = window.setTimeout(
      () => api.geocode(q).then(setHits).catch(() => setHits([])),
      200,
    );
  }, [q]);

  return (
    <div
      className="fixed inset-0 z-30 flex flex-col bg-night"
      ref={(el) => {
        if (!el) return;
        const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
        ro.observe(el);
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <BackButton onClick={onBack} />
        <div className="relative flex-1">
          <Icon name="search" size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-soft pointer-events-none" />
          <input
            ref={inputRef}
            id="search-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("line.searchHint")}
            aria-label={t("line.searchHint")}
            className="min-h-[48px] w-full rounded-[20px] border border-edge bg-raised pl-10 pr-4 text-[1.05rem] text-ink placeholder:text-soft"
          />
        </div>
      </div>

      {/* Save-as chips (only for "To" field) */}
      {field === "to" && (
        <div className="flex gap-2 px-4 pt-3">
          {(["home", "work"] as const).map((slot) => (
            <button
              key={slot}
              id={`save-as-${slot}`}
              onClick={() => setSave(save === slot ? null : slot)}
              aria-pressed={save === slot}
              className={`flex min-h-[44px] items-center gap-2 rounded-full border px-4 font-semibold text-[0.9rem] transition-colors ${
                save === slot ? "border-lime/60 bg-lime/10 text-lime" : "border-edge bg-raised text-soft hover:text-ink"
              }`}
            >
              <Icon name={slot === "home" ? "home" : "work"} size={16} />
              {slot === "home" ? t("label.setHome") : t("label.setWork")}
            </button>
          ))}
        </div>
      )}

      {/* Results */}
      <div className="flex-1 overflow-y-auto px-4 pt-2 scroll-quiet">
        {/* Pick on map */}
        <button
          id="pick-on-map-btn"
          onClick={() => onPickMap(save)}
          className="flex min-h-[56px] w-full items-center gap-3 rounded-[20px] bg-raised px-4 font-semibold text-ink hover:bg-edge/40 transition-colors mb-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface text-lime">
            <Icon name="map-pin" size={20} />
          </span>
          {t("label.pickOnMap")}
        </button>

        {hits === null && q.length < 2 && (
          <p className="mt-4 text-[0.95rem] text-soft text-center">{t("line.searchHint")}</p>
        )}
        {hits !== null && hits.length === 0 && (
          <p className="mt-4 text-[1.0rem] text-warn">{t("line.noResults")}</p>
        )}
        <ul className="space-y-1">
          {(hits || []).map((h, i) => (
            <li key={i}>
              <button
                onClick={() => onChoose({ lat: h.lat, lon: h.lon, name: h.name, kind: save }, save)}
                className="flex min-h-[56px] w-full items-center gap-3 rounded-[20px] px-4 text-left text-[1.05rem] font-semibold hover:bg-raised transition-colors"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-raised text-soft">
                  <Icon name="map-pin" size={18} />
                </span>
                <span className="min-w-0 flex-1 truncate">{h.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

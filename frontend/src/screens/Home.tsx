import { useState } from "react";
import { useT } from "../copy";
import { Icon } from "../components/Icon";
import { BigButton } from "../components/ui";
import type { Place } from "../types";

export const NEEDS = [
  { type: "medicine",  iconName: "medicine"  as const, key: "label.medicine"  },
  { type: "food",      iconName: "food"       as const, key: "label.food"      },
  { type: "hospital",  iconName: "hospital"   as const, key: "label.hospital"  },
  { type: "police",    iconName: "police"     as const, key: "label.police"    },
] as const;

/** Two-field pill stack: origin + destination, Google Maps style. */
export function TwoFieldCard({
  fromName,
  toName,
  onFrom,
  onTo,
  onSwap,
}: {
  fromName: string;
  toName: string;
  onFrom: () => void;
  onTo: () => void;
  onSwap: () => void;
}) {
  return (
    <div className="relative flex flex-col rounded-[28px] bg-surface shadow-lg">
      {/* From */}
      <button
        id="field-from"
        onClick={onFrom}
        className="flex min-h-[56px] items-center gap-3 px-5 py-3 text-left"
      >
        <span className="text-lime">
          <Icon name="origin-dot" size={18} />
        </span>
        <span className="flex-1 text-[1.05rem] font-semibold text-ink truncate">{fromName}</span>
      </button>

      {/* Divider + connector */}
      <div className="flex items-center gap-3 px-5">
        <div className="ml-[9px] h-5 w-0.5 bg-edge" aria-hidden="true" />
        <div className="flex-1 border-t border-edge" />
      </div>

      {/* To */}
      <button
        id="field-to"
        onClick={onTo}
        className="flex min-h-[56px] items-center gap-3 px-5 py-3 text-left"
      >
        <span className="text-soft">
          <Icon name="map-pin" size={18} />
        </span>
        <span className={`flex-1 text-[1.05rem] font-semibold truncate ${toName ? "text-ink" : "text-soft"}`}>
          {toName || "Where to?"}
        </span>
      </button>

      {/* Swap button */}
      <button
        onClick={onSwap}
        aria-label="Swap origin and destination"
        className="absolute right-4 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-raised border border-edge text-soft hover:text-ink transition-colors"
      >
        <Icon name="swap" size={18} />
      </button>
    </div>
  );
}

/** Facility category icon chips row */
export function NeedChips({ onNeed, activeFacilities }: {
  onNeed: (type: string) => void;
  activeFacilities?: Record<string, boolean>;
}) {
  const { t } = useT();
  return (
    <div className="flex gap-2" role="group" aria-label="Facility categories">
      {NEEDS.map((n) => {
        const active = activeFacilities?.[n.type];
        return (
          <button
            key={n.type}
            id={`need-chip-${n.type}`}
            onClick={() => onNeed(n.type)}
            aria-pressed={active}
            aria-label={t(n.key)}
            className={`flex flex-1 flex-col items-center gap-1 rounded-2xl border px-2 py-2.5 transition-colors ${
              active
                ? "border-lime/60 bg-lime/10 text-lime"
                : "border-edge bg-surface text-soft hover:text-ink"
            }`}
          >
            <Icon name={n.iconName} size={22} />
            <span className="text-[0.7rem] font-semibold">{t(n.key)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Footer with language toggle + optional demo button */
export function SheetFooter({ showDemo, onDemo }: { showDemo: boolean; onDemo: () => void }) {
  const { lang, setLang, t } = useT();
  return (
    <div className="mt-5 flex items-center justify-between">
      {showDemo ? (
        <button
          onClick={onDemo}
          className="min-h-[44px] rounded-xl px-2 text-[0.9rem] font-semibold text-soft underline-offset-4 hover:underline"
        >
          {t("label.demo")}
        </button>
      ) : <span />}
      <div className="flex items-center rounded-full border border-edge text-[0.9rem] font-semibold" role="group" aria-label="Language">
        {(["en", "hi"] as const).map((l) => (
          <button
            key={l}
            id={`lang-${l}`}
            onClick={() => setLang(l)}
            aria-pressed={lang === l}
            className={`min-h-[44px] min-w-[48px] px-3 rounded-full transition-colors ${
              lang === l ? "bg-raised text-ink" : "text-soft"
            }`}
          >
            {l === "en" ? "EN" : "हिं"}
          </button>
        ))}
      </div>
    </div>
  );
}

/** PART 3 Landing Home panel: map-first, floating card stack */
export function Home({
  from, to, home, work, when, by, busy, error,
  onFrom, onTo, onPlace, onWhen, onBy, onFind, onNeed,
  showDemo, onDemo, onHeight,
}: {
  from: Place | null; to: Place | null; home: Place | null; work: Place | null;
  when: string | null; by: string | null;
  busy: boolean; error: string | null;
  onFrom: () => void; onTo: () => void;
  onPlace: (p: Place | "home" | "work") => void;
  onWhen: (v: string | null) => void; onBy: (v: string | null) => void;
  onFind: () => void; onNeed: (type: string) => void;
  showDemo: boolean; onDemo: () => void; onHeight: (h: number) => void;
}) {
  const { t } = useT();
  const [timeFor, setTimeFor] = useState<"when" | "by" | null>(null);

  const fromName = !from
    ? t("label.myLocation")
    : from.kind === "here"
      ? t(from.demo ? "label.myLocationDemo" : "label.myLocation")
      : from.name;
  const toName = !to
    ? ""
    : to.kind === "home" ? t("label.home") : to.kind === "work" ? t("label.work") : to.name;
  const nice = (v: string) => {
    const [h, m] = v.split(":").map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, "0")}`;
  };

  const handleSwap = () => {
    if (!from || !to) return;
    // Swap is handled at App level via onFrom/onTo — simulate by opening from-field
    onFrom();
  };

  return (
    <>
      {/* Floating bottom panel */}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center"
        ref={(el) => {
          if (!el) return;
          const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
          ro.observe(el);
        }}
      >
        <div className="pointer-events-auto w-full max-w-[480px] space-y-3 px-4 pb-6 pt-3">
          {/* Two-field card */}
          <TwoFieldCard
            fromName={fromName}
            toName={toName}
            onFrom={onFrom}
            onTo={onTo}
            onSwap={handleSwap}
          />

          {/* Quick-access: Home / Work */}
          <div className="flex gap-2">
            {([["home", home], ["work", work]] as const).map(([slot, p]) => (
              <button
                key={slot}
                id={`quick-${slot}`}
                onClick={() => onPlace(slot)}
                aria-pressed={to?.kind === slot}
                title={p?.name}
                className={`flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-full border font-semibold text-[0.9rem] transition-colors ${
                  to?.kind === slot
                    ? "border-lime/60 bg-lime/10 text-lime"
                    : "border-edge bg-surface text-soft hover:text-ink"
                }`}
              >
                <Icon name={slot === "home" ? "home" : "work"} size={17} />
                {t(slot === "home" ? "label.home" : "label.work")}
              </button>
            ))}
          </div>

          {/* Time chips */}
          <div className="flex gap-2">
            <button
              onClick={() => setTimeFor("when")}
              className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-full border border-edge bg-surface px-3 font-semibold text-[0.9rem] text-ink"
            >
              <Icon name="clock" size={16} />
              {t("fmt.when", { time: when ? nice(when) : t("label.now") })}
            </button>
            <button
              onClick={() => setTimeFor("by")}
              className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-full border border-edge bg-surface px-3 font-semibold text-[0.9rem] text-ink"
            >
              <Icon name="flag" size={16} />
              {t("fmt.by", { time: by ? nice(by) : "--" })}
            </button>
          </div>

          {/* Facility need chips */}
          <NeedChips onNeed={onNeed} />

          {/* Error */}
          {error && (
            <p className="text-[1.0rem] font-semibold text-bad" role="alert">{error}</p>
          )}

          {/* Find button — shown when both fields set */}
          {from && to && (
            <BigButton onClick={onFind} disabled={busy}>
              {busy ? t("line.finding") : t("cta.findSafeWay")}
            </BigButton>
          )}

          <SheetFooter showDemo={showDemo} onDemo={onDemo} />
        </div>
      </div>

      {/* Time picker overlay */}
      {timeFor && (
        <TimeSheet
          title={timeFor === "when" ? t("label.when") : t("label.beThereBy")}
          value={timeFor === "when" ? when : by}
          clearLabel={timeFor === "when" ? t("label.now") : t("label.clear")}
          onDone={(v) => { (timeFor === "when" ? onWhen : onBy)(v); setTimeFor(null); }}
          onCancel={() => setTimeFor(null)}
        />
      )}
    </>
  );
}

function TimeSheet({ title, value, clearLabel, onDone, onCancel }: {
  title: string; value: string | null; clearLabel: string;
  onDone: (v: string | null) => void; onCancel: () => void;
}) {
  const { t } = useT();
  const [v, setV] = useState(value || "");
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[480px] rounded-t-[28px] bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <h2 className="mb-3 text-[1.3rem] font-bold">{title}</h2>
        <input
          type="time"
          value={v}
          onChange={(e) => setV(e.target.value)}
          aria-label={title}
          className="min-h-14 w-full rounded-[20px] border border-edge bg-raised px-4 text-[1.6rem] font-bold text-ink"
        />
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <button
            onClick={() => onDone(null)}
            className="min-h-14 rounded-[20px] border border-edge bg-raised font-semibold"
          >
            {clearLabel}
          </button>
          <BigButton onClick={() => onDone(v || null)}>{t("label.done")}</BigButton>
        </div>
      </div>
    </div>
  );
}

/** Standalone Field component for Search screen */
export function Field({ label, value, onClick, empty }: {
  label: string; value: string; onClick: () => void; empty?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="flex min-h-[56px] w-full items-center gap-3 rounded-[20px] border border-edge bg-raised px-4 text-left transition-colors hover:border-lime/30"
    >
      <span className="w-14 shrink-0 text-[0.9rem] font-semibold text-soft">{label}</span>
      <span className={`min-w-0 flex-1 truncate text-[1.05rem] font-semibold ${empty ? "text-soft" : "text-ink"}`}>
        {value}
      </span>
      <Icon name="chevron-right" size={18} className="text-soft" />
    </button>
  );
}

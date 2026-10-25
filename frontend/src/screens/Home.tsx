import { useState } from "react";
import { useT } from "../copy";
import { Chevron } from "../components/icons";
import { BigButton, Sheet } from "../components/ui";
import type { Place } from "../types";

export const NEEDS = [
  { type: "medicine", icon: "💊", key: "label.medicine" },
  { type: "food", icon: "🍲", key: "label.food" },
  { type: "hospital", icon: "🏥", key: "label.hospital" },
  { type: "police", icon: "👮", key: "label.police" },
] as const;

export function Field({ label, value, onClick, empty }: { label: string; value: string; onClick: () => void; empty?: boolean }) {
  return (
    <button onClick={onClick} className="flex min-h-14 w-full items-center gap-3 rounded-2xl border border-edge bg-raised px-4 text-left">
      <span className="w-14 shrink-0 text-[0.95rem] font-semibold text-soft">{label}</span>
      <span className={`min-w-0 flex-1 truncate text-[1.1rem] font-semibold ${empty ? "text-soft" : "text-ink"}`}>{value}</span>
      <Chevron />
    </button>
  );
}

export function SheetFooter({ showDemo, onDemo }: { showDemo: boolean; onDemo: () => void }) {
  const { lang, setLang, t } = useT();
  return (
    <div className="mt-4 flex items-center justify-between">
      {showDemo ? (
        <button onClick={onDemo} className="min-h-11 rounded-xl px-2 text-[0.95rem] font-semibold text-soft underline-offset-4 hover:underline">
          {t("label.demo")}
        </button>
      ) : <span />}
      <div className="flex items-center rounded-xl border border-edge text-[0.95rem] font-semibold" role="group" aria-label="Language">
        {(["en", "hi"] as const).map((l) => (
          <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l}
            className={`min-h-11 min-w-12 px-3 ${lang === l ? "rounded-xl bg-raised text-ink" : "text-soft"}`}>
            {l === "en" ? "EN" : "हिं"}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Home({ from, to, home, work, when, by, busy, error, onFrom, onTo, onPlace, onWhen, onBy, onFind, onNeed, showDemo, onDemo, onHeight }: {
  from: Place | null; to: Place | null; home: Place | null; work: Place | null; when: string | null; by: string | null;
  busy: boolean; error: string | null; onFrom: () => void; onTo: () => void; onPlace: (p: Place | "home" | "work") => void;
  onWhen: (v: string | null) => void; onBy: (v: string | null) => void; onFind: () => void; onNeed: (type: string) => void;
  showDemo: boolean; onDemo: () => void; onHeight: (h: number) => void;
}) {
  const { t } = useT();
  const [timeFor, setTimeFor] = useState<"when" | "by" | null>(null);
  const fromName = !from ? "…" : from.kind === "here" ? t(from.demo ? "label.myLocationDemo" : "label.myLocation") : from.name;
  const toName = !to ? "" : to.kind === "home" ? t("label.home") : to.kind === "work" ? t("label.work") : to.name;
  const nice = (v: string) => { const [h, m] = v.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")}`; };

  return (
    <Sheet onHeight={onHeight}>
      <h1 className="mb-3 text-[1.5rem] font-bold">{t("line.whereTo")}</h1>
      <div className="space-y-2.5">
        <Field label={t("label.from")} value={fromName} onClick={onFrom} />
        <Field label={t("label.to")} value={toName || "🔍"} empty={!toName} onClick={onTo} />
        <div className="grid grid-cols-2 gap-2.5">
          {([["home", "⌂", home], ["work", "💼", work]] as const).map(([slot, icon, p]) => (
            <button key={slot} onClick={() => onPlace(slot)}
              className={`flex min-h-12 items-center justify-center gap-2 rounded-2xl border px-3 font-semibold ${to?.kind === slot ? "border-accent bg-accent/15 text-ink" : "border-edge bg-raised text-ink"}`}
              aria-pressed={to?.kind === slot} title={p?.name}>
              <span aria-hidden="true">{icon}</span>{t(slot === "home" ? "label.home" : "label.work")}
            </button>
          ))}
        </div>
        <div className="flex gap-2.5">
          <button onClick={() => setTimeFor("when")} className="min-h-12 flex-1 rounded-full border border-edge bg-raised px-3 font-semibold">
            {t("fmt.when", { time: when ? nice(when) : t("label.now") })}
          </button>
          <button onClick={() => setTimeFor("by")} className="min-h-12 flex-1 rounded-full border border-edge bg-raised px-3 font-semibold">
            {t("fmt.by", { time: by ? nice(by) : "–" })}
          </button>
        </div>
      </div>

      {error && <p className="mt-3 text-[1.05rem] font-semibold text-warn" role="alert">{error}</p>}
      <div className="mt-4">
        <BigButton onClick={onFind} disabled={busy || !from || !to}>{busy ? t("line.finding") : t("cta.findSafeWay")}</BigButton>
      </div>

      <div className="mt-5 grid grid-cols-4 gap-2">
        {NEEDS.map((n) => (
          <button key={n.type} onClick={() => onNeed(n.type)} className="flex flex-col items-center gap-1.5" aria-label={t(n.key)}>
            <span className="flex h-16 w-16 items-center justify-center rounded-full border border-edge bg-raised text-[1.7rem]" aria-hidden="true">{n.icon}</span>
            <span className="text-[0.95rem] font-semibold">{t(n.key)}</span>
          </button>
        ))}
      </div>

      <SheetFooter showDemo={showDemo} onDemo={onDemo} />

      {timeFor && (
        <TimeSheet title={timeFor === "when" ? t("label.when") : t("label.beThereBy")} value={timeFor === "when" ? when : by}
          clearLabel={timeFor === "when" ? t("label.now") : t("label.clear")}
          onDone={(v) => { (timeFor === "when" ? onWhen : onBy)(v); setTimeFor(null); }} onCancel={() => setTimeFor(null)} />
      )}
    </Sheet>
  );
}

function TimeSheet({ title, value, clearLabel, onDone, onCancel }: {
  title: string; value: string | null; clearLabel: string; onDone: (v: string | null) => void; onCancel: () => void;
}) {
  const { t } = useT();
  const [v, setV] = useState(value || "");
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onClick={onCancel}>
      <div className="w-full max-w-[480px] rounded-t-3xl bg-surface p-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <h2 className="mb-3 text-[1.3rem] font-bold">{title}</h2>
        <input type="time" value={v} onChange={(e) => setV(e.target.value)} aria-label={title}
          className="min-h-14 w-full rounded-2xl border border-edge bg-raised px-4 text-[1.6rem] font-bold text-ink" />
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <button onClick={() => onDone(null)} className="min-h-14 rounded-2xl border border-edge bg-raised font-semibold">{clearLabel}</button>
          <BigButton onClick={() => onDone(v || null)}>{t("label.done")}</BigButton>
        </div>
      </div>
    </div>
  );
}

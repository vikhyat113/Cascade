import { useEffect, useRef, type ReactNode } from "react";
import { useT } from "../copy";
import { Chevron } from "./icons";

/** Bottom sheet: phone width, centred on desktop (max 480px), map behind it. */
export function Sheet({ children, onHeight }: { children: ReactNode; onHeight?: (h: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || !onHeight) return;
    const ro = new ResizeObserver(() => onHeight(ref.current!.offsetHeight));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [onHeight]);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center">
      <section ref={ref} className="nw-sheet scroll-quiet pointer-events-auto max-h-[78dvh] w-full max-w-[480px] overflow-y-auto rounded-t-3xl border-t border-edge bg-surface px-5 pb-6 pt-3">
        <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-edge" aria-hidden="true" />
        {children}
      </section>
    </div>
  );
}

export function BigButton({ children, onClick, disabled, tone = "accent", label }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; tone?: "accent" | "help"; label?: string;
}) {
  const cls = tone === "help" ? "bg-help text-white" : "bg-accent text-accent-ink";
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label}
      className={`flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl px-5 text-[1.25rem] font-bold disabled:opacity-50 ${cls}`}>
      {children}
    </button>
  );
}

export function QuietButton({ children, onClick, label, className = "" }: { children: ReactNode; onClick?: () => void; label?: string; className?: string }) {
  return (
    <button onClick={onClick} aria-label={label}
      className={`flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-edge bg-raised px-4 font-semibold text-ink ${className}`}>
      {children}
    </button>
  );
}

export function BackButton({ onClick }: { onClick: () => void }) {
  const { t } = useT();
  return (
    <button onClick={onClick} aria-label={t("label.back")}
      className="-ml-2 flex h-12 w-12 items-center justify-center rounded-full text-ink hover:bg-raised">
      <Chevron dir="left" />
    </button>
  );
}

/** Live / Offline pill: the only thing at the top of the screen. */
export function Pill({ connection, long = false }: { connection: "live" | "offline"; long?: boolean }) {
  const { t } = useT();
  const live = connection === "live";
  return (
    <div className="pointer-events-none fixed left-3 top-3 z-30 flex max-w-[calc(100%-6rem)]">
      <div role="status" aria-live="polite"
        className="flex min-h-9 items-center gap-2 rounded-full border border-edge bg-surface/95 px-4 text-[0.95rem] font-semibold">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${live ? "bg-good" : "bg-soft"}`} aria-hidden="true" />
        {live ? t("label.live") : long ? t("line.offlineSaved") : t("label.offline")}
      </div>
    </div>
  );
}

/** One plain banner at a time; hides itself after 8 seconds (UI_SPEC §2 screen 3). */
export function Banner({ id, text, onSee, onDone }: { id: string; text: string; onSee?: () => void; onDone: () => void }) {
  const { t } = useT();
  const done = useRef(onDone);
  done.current = onDone;
  // the timer belongs to this banner (id), not to each live update re-render
  useEffect(() => { const h = window.setTimeout(() => done.current(), 8000); return () => window.clearTimeout(h); }, [id]);
  return (
    <div className="fixed inset-x-0 top-[5rem] z-40 flex justify-center px-3">
      <div role="alert" className="flex w-full max-w-[480px] items-center gap-3 rounded-2xl bg-warn px-4 py-3 text-night shadow-xl">
        <span className="flex-1 text-[1.05rem] font-bold">{text}</span>
        {onSee && (
          <button onClick={() => { onSee(); onDone(); }} className="min-h-11 rounded-xl bg-night px-4 font-bold text-warn">
            {t("label.see")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Deviation warning (UPGRADE §7): one banner, gentle ("off") or strong ("far"). */
export function DeviationBanner({ level, onNewWay, onFine, sms, onSos }: {
  level: "off" | "far"; onNewWay: () => void; onFine: () => void; sms: string; onSos: () => void;
}) {
  const { t } = useT();
  const far = level === "far";
  const btn = "min-h-11 rounded-xl px-3 font-bold";
  return (
    <div className="fixed inset-x-0 top-[5rem] z-40 flex justify-center px-3">
      <div role="alert" className={`w-full max-w-[480px] rounded-2xl px-4 py-3 shadow-xl ${far ? "bg-bad text-night" : "bg-warn text-night"}`}>
        <p className="text-[1.1rem] font-bold">{t(far ? "line.farWay" : "line.offWay")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button onClick={onNewWay} className={`${btn} bg-night text-ink`}>{t("label.newWay")}</button>
          {far ? (
            <>
              <a href={sms} className={`${btn} flex items-center bg-night/80 text-ink`}>{t("label.callSomeone")}</a>
              <button onClick={onSos} className={`${btn} bg-help text-white`}>{t("label.sos")}</button>
            </>
          ) : <button onClick={onFine} className={`${btn} border-2 border-night`}>{t("label.imFine")}</button>}
        </div>
      </div>
    </div>
  );
}

/** Small chip while the demo is moving time or location (never on a normal trip). */
export function DemoChip() {
  const { t } = useT();
  return <span className="whitespace-nowrap rounded-full border border-warn/70 px-2.5 py-0.5 text-[0.85rem] font-semibold text-warn">{t("label.demoTime")}</span>;
}

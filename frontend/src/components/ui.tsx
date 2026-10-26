import { useEffect, useRef, type ReactNode } from "react";
import { useT } from "../copy";
import { Icon } from "./Icon";

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
      <section
        ref={ref}
        className="nw-sheet scroll-quiet pointer-events-auto max-h-[82dvh] w-full max-w-[480px] overflow-y-auto rounded-t-[28px] border-t border-edge bg-surface px-5 pb-8 pt-3"
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-edge" aria-hidden="true" />
        {children}
      </section>
    </div>
  );
}

export function BigButton({ children, onClick, disabled, tone = "lime", label }: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "lime" | "help" | "pill";
  label?: string;
}) {
  const cls =
    tone === "help" ? "bg-help text-white" :
    tone === "pill" ? "bg-pill text-pill-ink" :
    "bg-lime text-lime-ink";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`flex min-h-14 w-full items-center justify-center gap-2 rounded-[20px] px-5 text-[1.15rem] font-bold shadow-md disabled:opacity-50 transition-transform active:scale-[0.97] ${cls}`}
    >
      {children}
    </button>
  );
}

export function PillButton({ children, onClick, active = false, label, className = "" }: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-full px-4 font-semibold text-[0.9rem] transition-colors ${
        active
          ? "bg-lime text-lime-ink shadow-md"
          : "bg-pill text-pill-ink hover:bg-raised"
      } ${className}`}
    >
      {children}
    </button>
  );
}

export function QuietButton({ children, onClick, label, className = "" }: {
  children: ReactNode;
  onClick?: () => void;
  label?: string;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={`flex min-h-12 items-center justify-center gap-2 rounded-[20px] border border-edge bg-raised px-4 font-semibold text-ink transition-colors hover:border-lime/30 ${className}`}
    >
      {children}
    </button>
  );
}

export function BackButton({ onClick }: { onClick: () => void }) {
  const { t } = useT();
  return (
    <button
      onClick={onClick}
      aria-label={t("label.back")}
      className="flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-ink hover:bg-raised transition-colors"
    >
      <Icon name="chevron-left" size={22} />
    </button>
  );
}

/** Live / Offline pill: restyled to black pill */
export function Pill({ connection }: { connection: "live" | "offline" }) {
  const { t } = useT();
  const live = connection === "live";
  return (
    <div className="pointer-events-none fixed left-0 right-0 top-4 z-30 flex justify-center">
      <div
        role="status"
        aria-live="polite"
        className="flex min-h-[36px] items-center gap-2 rounded-full bg-pill px-4 shadow-lg text-[0.85rem] font-semibold text-pill-ink"
      >
        <span
          className={`inline-block h-2 w-2 rounded-full ${live ? "bg-lime" : "bg-soft"}`}
          aria-hidden="true"
        />
        {live ? t("label.live") : t("line.offlineSaved")}
      </div>
    </div>
  );
}

/** One plain banner at a time; hides itself after 8 seconds. */
export function Banner({ id, text, onSee, onDone }: {
  id: string;
  text: string;
  onSee?: () => void;
  onDone: () => void;
}) {
  const { t } = useT();
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const h = window.setTimeout(() => done.current(), 8000);
    return () => window.clearTimeout(h);
  }, [id]);
  return (
    <div className="fixed inset-x-0 top-16 z-40 flex justify-center px-4">
      <div
        role="alert"
        className="flex w-full max-w-[480px] items-center gap-3 rounded-[20px] bg-warn px-4 py-3 text-night shadow-xl"
      >
        <Icon name="alert-triangle" size={20} className="shrink-0" />
        <span className="flex-1 text-[1.0rem] font-bold">{text}</span>
        {onSee && (
          <button
            onClick={() => { onSee(); onDone(); }}
            className="min-h-[44px] rounded-xl bg-night px-4 font-bold text-warn"
          >
            {t("label.see")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Tier chip — shape AND colour differentiated, never colour alone. */
export function TierChip({ tier }: { tier: string }) {
  const cls: Record<string, string> = {
    KNOWN:    "chip-known",
    PROBABLE: "chip-probable",
    OUTDATED: "chip-outdated",
    UNKNOWN:  "chip-unknown",
  };
  return <span className={cls[tier] ?? "chip-unknown"}>{tier}</span>;
}

/** Layer status chip */
export function StatusChip({ status }: { status: string }) {
  const cls: Record<string, string> = {
    LIVE:    "chip-live",
    CACHED:  "chip-cached",
    STALE:   "chip-stale",
    OFFLINE: "chip-offline",
  };
  return <span className={cls[status] ?? "chip-offline"}>{status}</span>;
}

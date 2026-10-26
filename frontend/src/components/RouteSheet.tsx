/**
 * RouteSheet.tsx — PART 4: Route sheet with all routes as cards + telemetry.
 *
 * Bottom sheet on phone; left panel 400px on desktop >= 1024px.
 * Shows all routes (Safest, Balanced, Fastest + diverse alternatives).
 * Recommended route gets lime card with topographic pattern.
 * Tapping a card selects it and swaps the telemetry below.
 */
import { useState } from "react";
import { useT } from "../copy";
import { Icon } from "./Icon";
import { TierChip } from "./ui";
import { TelemetryTimeline } from "./TelemetryTimeline";
import type { RouteItem, RouteTelemetry } from "../types";

interface Props {
  routes: RouteItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onStart: () => void;
  starting: boolean;
  onClose: () => void;
  fromName: string;
  toName: string;
  onSwap: () => void;
  tripProgressM?: number;
  tripStarted?: boolean;
}

function safetyLabel(lo: number, hi: number): { text: string; cls: string; icon: "shield-check" | "shield-alert" } {
  const mid = (lo + hi) / 2;
  if (mid < 0.35) return { text: "Low risk", cls: "text-good", icon: "shield-check" };
  if (mid < 0.65) return { text: "Moderate risk", cls: "text-warn", icon: "shield-alert" };
  return { text: "High risk", cls: "text-bad", icon: "shield-alert" };
}

function feasibilityLabel(r: RouteItem): { text: string; cls: string; icon: "check-circle" | "alert-triangle" | "x-circle" } {
  if (!r.metrics.feasible.worst) return { text: "May be too late", cls: "text-bad", icon: "x-circle" };
  if (!r.metrics.feasible.expected) return { text: "Could be late", cls: "text-warn", icon: "alert-triangle" };
  return { text: "On time", cls: "text-good", icon: "check-circle" };
}

function RouteCard({
  route,
  selected,
  onSelect,
}: {
  route: RouteItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const safety = safetyLabel(route.metrics.safety.lo, route.metrics.safety.hi);
  const feasibility = feasibilityLabel(route);
  const durationMin = route.metrics.duration_min.expected;
  const isRec = route.recommended;

  const cardCls = isRec
    ? "nw-topo-pattern border-lime/50 bg-lime/10 text-card-ink"
    : selected
      ? "border-lime/30 bg-raised"
      : "border-edge bg-raised hover:border-lime/20";

  return (
    <button
      id={`route-card-${route.id}`}
      onClick={onSelect}
      aria-pressed={selected}
      className={`relative w-full rounded-[20px] border px-4 py-3.5 text-left transition-all ${cardCls}`}
    >
      {/* Recommended badge */}
      {isRec && (
        <span className="absolute right-3 top-3 rounded-full bg-lime px-2.5 py-0.5 text-[0.7rem] font-bold text-lime-ink uppercase tracking-wide">
          Recommended
        </span>
      )}

      {/* Label + duration */}
      <div className="flex items-baseline gap-2 pr-24">
        <span className={`text-[1.0rem] font-bold ${isRec ? "text-lime-ink" : "text-ink"}`}>
          {route.label}
        </span>
        {route.dominated && (
          <span className="text-[0.72rem] font-semibold text-soft">(dominated)</span>
        )}
      </div>
      <p className={`text-[1.4rem] font-bold leading-tight ${isRec ? "text-lime-ink" : "text-ink"}`}>
        {durationMin != null ? `${Math.round(durationMin)} min` : "—"}
      </p>

      {/* Feasibility + safety badges */}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <span className={`flex items-center gap-1 text-[0.82rem] font-semibold ${feasibility.cls}`}>
          <Icon name={feasibility.icon} size={14} />
          {feasibility.text}
        </span>
        <span className="text-soft text-[0.8rem]">·</span>
        <span className={`flex items-center gap-1 text-[0.82rem] font-semibold ${safety.cls}`}>
          <Icon name={safety.icon} size={14} />
          {safety.text}
        </span>
        {route.metrics.limiting_status && (
          <>
            <span className="text-soft text-[0.8rem]">·</span>
            <TierChip tier={route.metrics.limiting_status} />
          </>
        )}
      </div>

      {/* One-line "why" */}
      {route.why && (
        <p className={`mt-1 text-[0.8rem] ${isRec ? "text-lime-ink/70" : "text-soft"}`}>{route.why}</p>
      )}

      {/* Stats strip */}
      <div className={`mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.75rem] ${isRec ? "text-lime-ink/60" : "text-muted"}`}>
        {route.metrics.distance_m > 0 && (
          <span>{(route.metrics.distance_m / 1000).toFixed(1)} km</span>
        )}
        {route.metrics.outdoor_min > 0 && (
          <span>{Math.round(route.metrics.outdoor_min)} min outdoors</span>
        )}
        {route.metrics.unknown_lighting_share > 0 && (
          <span className={isRec ? "text-lime-ink/50" : "text-warn/80"}>
            {Math.round(route.metrics.unknown_lighting_share * 100)}% unknown lighting
          </span>
        )}
        {(route.telemetry as RouteTelemetry | undefined)?.max_gap_m != null &&
          (route.telemetry as RouteTelemetry).max_gap_m > 0 && (
          <span>
            longest gap {Math.round((route.telemetry as RouteTelemetry).max_gap_m)} m
          </span>
        )}
      </div>
    </button>
  );
}

export function RouteSheet({
  routes,
  selectedId,
  onSelect,
  onStart,
  starting,
  onClose,
  fromName,
  toName,
  onSwap,
  tripProgressM = 0,
  tripStarted = false,
}: Props) {
  const { t } = useT();
  const [collapsed, setCollapsed] = useState(false);
  const nonDominated = routes.filter((r) => !r.dominated);
  const dominated = routes.filter((r) => r.dominated);
  const [showDominated, setShowDominated] = useState(false);
  const displayRoutes = showDominated ? routes : nonDominated;

  const selectedRoute = routes.find((r) => r.id === selectedId) ?? routes[0];
  const selectedTelemetry = (selectedRoute as any)?.telemetry as RouteTelemetry | undefined;

  return (
    <>
      {/* ── Mobile: bottom sheet ── */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center lg:hidden">
        <section className="nw-sheet scroll-quiet pointer-events-auto max-h-[82dvh] w-full max-w-[480px] overflow-y-auto rounded-t-[28px] border-t border-edge bg-surface pb-8 pt-1">
          {/* Drag handle */}
          <div className="flex justify-center pt-2 pb-1">
            <button
              onClick={() => setCollapsed(!collapsed)}
              aria-label="Toggle sheet"
              className="h-1.5 w-10 rounded-full bg-edge"
            />
          </div>

          {!collapsed && (
            <div className="px-4">
              <RouteSheetInner
                routes={displayRoutes}
                dominated={dominated}
                showDominated={showDominated}
                onToggleDominated={setShowDominated}
                selectedId={selectedId}
                onSelect={onSelect}
                onStart={onStart}
                starting={starting}
                onClose={onClose}
                fromName={fromName}
                toName={toName}
                onSwap={onSwap}
                selectedTelemetry={selectedTelemetry}
                tripProgressM={tripProgressM}
                tripStarted={tripStarted}
                t={t}
              />
            </div>
          )}
        </section>
      </div>

      {/* ── Desktop: left panel ── */}
      <div className="pointer-events-none fixed inset-y-0 left-0 z-20 hidden lg:flex">
        <section className="nw-sheet scroll-quiet pointer-events-auto h-full w-[400px] overflow-y-auto border-r border-edge bg-surface pb-8 pt-4">
          <div className="px-5">
            <RouteSheetInner
              routes={displayRoutes}
              dominated={dominated}
              showDominated={showDominated}
              onToggleDominated={setShowDominated}
              selectedId={selectedId}
              onSelect={onSelect}
              onStart={onStart}
              starting={starting}
              onClose={onClose}
              fromName={fromName}
              toName={toName}
              onSwap={onSwap}
              selectedTelemetry={selectedTelemetry}
              tripProgressM={tripProgressM}
              tripStarted={tripStarted}
              t={t}
            />
          </div>
        </section>
      </div>
    </>
  );
}

function RouteSheetInner({
  routes,
  dominated,
  showDominated,
  onToggleDominated,
  selectedId,
  onSelect,
  onStart,
  starting,
  onClose,
  fromName,
  toName,
  onSwap,
  selectedTelemetry,
  tripProgressM,
  tripStarted,
  t,
}: {
  routes: RouteItem[];
  dominated: RouteItem[];
  showDominated: boolean;
  onToggleDominated: (v: boolean) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onStart: () => void;
  starting: boolean;
  onClose: () => void;
  fromName: string;
  toName: string;
  onSwap: () => void;
  selectedTelemetry: RouteTelemetry | undefined;
  tripProgressM: number;
  tripStarted: boolean;
  t: (key: any, args?: any) => string;
}) {
  return (
    <>
      {/* Header: from → to + swap + close */}
      <div className="mb-4 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[0.82rem] text-soft">
            <Icon name="origin-dot" size={12} className="shrink-0 text-lime" />
            <span className="truncate">{fromName}</span>
          </div>
          <div className="my-0.5 ml-[5px] h-3 w-0.5 bg-edge" />
          <div className="flex items-center gap-1.5 text-[0.82rem] text-ink font-semibold">
            <Icon name="map-pin" size={12} className="shrink-0 text-soft" />
            <span className="truncate">{toName}</span>
          </div>
        </div>
        <button
          onClick={onSwap}
          aria-label="Swap"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-edge bg-raised text-soft hover:text-ink"
        >
          <Icon name="swap" size={16} />
        </button>
        <button
          onClick={onClose}
          aria-label="Close"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-edge bg-raised text-soft hover:text-ink"
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      {/* Route cards */}
      <div className="space-y-2.5">
        {routes.map((r) => (
          <RouteCard
            key={r.id}
            route={r}
            selected={r.id === selectedId}
            onSelect={() => onSelect(r.id)}
          />
        ))}
      </div>

      {/* Show dominated toggle */}
      {dominated.length > 0 && (
        <button
          onClick={() => onToggleDominated(!showDominated)}
          className="mt-2 flex min-h-[44px] items-center gap-1.5 text-[0.82rem] font-semibold text-soft hover:text-ink"
        >
          <Icon name={showDominated ? "chevron-up" : "chevron-down"} size={14} />
          {showDominated ? "Hide" : `Show ${dominated.length} more`} routes
        </button>
      )}

      {/* Start trip button for selected route */}
      {selectedId && (
        <button
          id="start-trip-btn"
          onClick={onStart}
          disabled={starting}
          className="mt-4 flex min-h-14 w-full items-center justify-center gap-2 rounded-[20px] bg-lime text-lime-ink text-[1.1rem] font-bold disabled:opacity-50 shadow-md transition-transform active:scale-[0.97]"
        >
          <Icon name="walk" size={18} />
          {starting ? t("line.finding") : t("label.start")}
        </button>
      )}

      {/* Telemetry divider */}
      <div className="mt-5 mb-3 flex items-center gap-2">
        <div className="h-px flex-1 bg-edge" />
        <span className="text-[0.75rem] font-semibold uppercase tracking-wide text-soft">
          Route telemetry
        </span>
        <div className="h-px flex-1 bg-edge" />
      </div>

      {/* Telemetry timeline */}
      <TelemetryTimeline
        telemetry={selectedTelemetry}
        progressM={tripProgressM}
        tripStarted={tripStarted}
      />
    </>
  );
}

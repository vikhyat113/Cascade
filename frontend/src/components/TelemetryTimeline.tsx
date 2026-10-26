/**
 * TelemetryTimeline.tsx — Per-route live telemetry timeline (PART 5 frontend).
 *
 * Shows a vertical rail of events (POIs, road transitions, lighting, gap warnings).
 * Distances count down in real-time as the trip progresses.
 * Never shows invented data; if no events are mapped, says so plainly.
 */
import { useMemo, type CSSProperties } from "react";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { TierChip } from "./ui";
import type { TelemetryEvent, RouteTelemetry } from "../types";

interface Props {
  telemetry: RouteTelemetry | null | undefined;
  /** Current position along route in metres (0 = start) */
  progressM?: number;
  /** Whether the trip has started */
  tripStarted?: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

const ICON_MAP: Record<string, IconName> = {
  hospital:     "hospital",
  police:       "police",
  medicine:     "medicine",
  "petrol-pump":"petrol-pump",
  food:         "food",
  metro:        "metro",
  atm:          "atm",
  landmark:     "landmark",
  sos:          "sos",
  "gap-warning":"gap-warning",
  road:         "road",
  highway:      "highway",
  lamp:         "lamp",
  "lamp-off":   "lamp-off",
  barrier:      "barrier",
  walk:         "walk",
  "unknown-light": "unknown-light",
};

function eventIcon(ev: TelemetryEvent): IconName {
  return ICON_MAP[ev.icon_key] ?? "info";
}

function hoursLabel(ev: TelemetryEvent): { text: string; cls: string } {
  switch (ev.hours_state) {
    case "open":       return { text: "Open",        cls: "text-good" };
    case "maybe_open": return { text: "Maybe open",  cls: "text-warn" };
    case "closed":     return { text: "Closed",      cls: "text-bad"  };
    default:           return { text: "Hours unknown", cls: "text-soft" };
  }
}

function formatDist(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function formatEta(s: number): string {
  if (s < 60) return "< 1 min";
  const min = Math.round(s / 60);
  if (min < 60) return `~${min} min`;
  return `~${Math.floor(min / 60)} h ${min % 60} min`;
}

function EventRow({ ev, remainM, passed }: { ev: TelemetryEvent; remainM: number; passed: boolean }) {
  const hours = hoursLabel(ev);
  const icon = eventIcon(ev);
  const isGap = ev.type === "gap_warning";
  const isLighting = ev.type === "lighting";

  const rowStyle: CSSProperties = passed ? { opacity: 0.35 } : {};

  if (isGap || isLighting) {
    return (
      <div
        className={`relative flex gap-3 py-2 ${passed ? "opacity-40" : ""}`}
        style={rowStyle}
      >
        {/* Rail: dashed for gap/unknown */}
        <div className="flex flex-col items-center">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-warn/15 text-warn">
            <Icon name={icon} size={16} />
          </div>
          {/* Dashed connector */}
          <div className="my-0.5 h-full min-h-[24px] w-0.5 border-l-2 border-dashed border-warn/40" />
        </div>
        <div className="min-w-0 flex-1 pt-1">
          <p className="text-[0.9rem] font-semibold text-warn">{ev.name}</p>
          <p className="text-[0.78rem] text-soft mt-0.5">
            {ev.length_m ? `${formatDist(ev.length_m)} stretch` : ""}
            {remainM >= 0 && ` · in ${formatDist(remainM)}`}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`relative flex gap-3 py-2 transition-opacity`}
      style={rowStyle}
    >
      <div className="flex flex-col items-center">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
            passed
              ? "border-edge bg-raised text-soft"
              : ev.hours_state === "open"
                ? "border-good/40 bg-good/10 text-good"
                : ev.hours_state === "maybe_open"
                  ? "border-warn/40 bg-warn/10 text-warn"
                  : "border-edge bg-raised text-muted"
          }`}
        >
          <Icon name={icon} size={16} />
        </div>
        <div className="my-0.5 h-full min-h-[16px] w-0.5 bg-edge" />
      </div>

      <div className="min-w-0 flex-1 pt-1">
        <div className="flex items-start justify-between gap-2">
          <p className={`text-[0.92rem] font-semibold leading-snug ${passed ? "text-soft" : "text-ink"}`}>
            {ev.name}
          </p>
          <TierChip tier={ev.tier} />
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.78rem]">
          {!passed && remainM >= 0 && (
            <span className="text-soft">
              in {formatDist(remainM)} · about {formatEta(ev.eta_expected_s)}
            </span>
          )}
          <span className={hours.cls}>{hours.text}</span>
          {ev.source === "osm_pois" && (
            <span className="text-muted">OSM</span>
          )}
          {ev.last_osm_edit && (
            <span className="text-muted">{ev.last_osm_edit.slice(0, 10)}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function TelemetryTimeline({ telemetry, progressM = 0, tripStarted = false, loading, error, onRetry }: Props) {
  const events = telemetry?.events ?? [];
  const totalM = telemetry?.total_length_m ?? 0;

  const processedEvents = useMemo(() => {
    return events.map((ev) => ({
      ev,
      remainM: Math.max(0, ev.chainage_m - progressM),
      passed: progressM > ev.chainage_m + 20,
    }));
  }, [events, progressM]);

  const nextEvent = processedEvents.find((e) => !e.passed);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-soft text-[0.9rem]">
        <div className="h-4 w-4 rounded-full border-2 border-lime border-t-transparent animate-spin" />
        Loading telemetry…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-[16px] bg-raised p-4 text-center">
        <p className="text-[0.9rem] text-soft">{error}</p>
        {onRetry && (
          <button onClick={onRetry} className="mt-2 text-[0.85rem] font-semibold text-lime underline">
            Retry
          </button>
        )}
      </div>
    );
  }

  if (!telemetry || (events.length === 0 && (telemetry.max_gap_m === 0))) {
    return (
      <div className="rounded-[16px] bg-raised px-4 py-3">
        <p className="text-[0.88rem] text-soft">No landmarks mapped near this route.</p>
        {telemetry?.max_gap_m != null && telemetry.max_gap_m > 200 && (
          <p className="mt-1 text-[0.85rem] text-warn">
            Longest gap without mapped help: {formatDist(telemetry.max_gap_m)}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2">
      {/* Summary stats */}
      {telemetry.max_gap_m > 0 && (
        <div className="mb-3 flex flex-wrap gap-2 text-[0.78rem] font-semibold">
          <span className="rounded-full border border-edge bg-raised px-2.5 py-1 text-soft">
            {events.filter((e) => e.type === "poi").length} help points
          </span>
          {telemetry.max_gap_m > 0 && (
            <span className="rounded-full border border-warn/40 bg-warn/10 px-2.5 py-1 text-warn">
              longest gap {formatDist(telemetry.max_gap_m)}
            </span>
          )}
          {telemetry.unknown_lighting_m > 0 && (
            <span className="rounded-full border border-edge bg-raised px-2.5 py-1 text-soft">
              {formatDist(telemetry.unknown_lighting_m)} unknown lighting
            </span>
          )}
        </div>
      )}

      {/* "You" marker at start */}
      {!tripStarted && (
        <div className="mb-1 flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-lime text-lime-ink">
            <Icon name="origin-dot" size={14} />
          </div>
          <span className="text-[0.85rem] font-bold text-lime">You</span>
        </div>
      )}

      {/* Next event highlight */}
      {tripStarted && nextEvent && (
        <div className="mb-3 rounded-[16px] bg-lime/10 border border-lime/30 px-3 py-2.5">
          <p className="text-[0.75rem] font-bold uppercase tracking-wide text-lime mb-0.5">Next</p>
          <div className="flex items-center gap-2">
            <Icon name={eventIcon(nextEvent.ev)} size={18} className="text-lime shrink-0" />
            <div>
              <p className="text-[0.95rem] font-semibold text-ink">{nextEvent.ev.name}</p>
              <p className="text-[0.78rem] text-soft">
                in {formatDist(nextEvent.remainM)} · {formatEta(nextEvent.ev.eta_expected_s)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Rail */}
      <div className="pl-1">
        {processedEvents.map(({ ev, remainM, passed }) => (
          <EventRow key={ev.id} ev={ev} remainM={remainM} passed={passed} />
        ))}
        {/* Destination */}
        <div className="flex items-center gap-3 pt-1">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-lime/50 bg-lime/10 text-lime">
            <Icon name="flag" size={15} />
          </div>
          <span className="text-[0.85rem] font-semibold text-soft">
            {totalM > 0 ? `Destination · ${formatDist(totalM)} total` : "Destination"}
          </span>
        </div>
      </div>
    </div>
  );
}

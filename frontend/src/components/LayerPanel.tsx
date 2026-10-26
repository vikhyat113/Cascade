import { useEffect, useState } from "react";
import { useT } from "../copy";
import type { LayerMeta, OriginForecastPoint, StatusChip, ViewMode } from "../types";
import { ago } from "../demo/demoApi";
import { api } from "../api";

export interface LayerState {
  showCoverage: boolean;
  facilities: {
    medicine: boolean;
    food: boolean;
    hospital: boolean;
    police: boolean;
    openOnly: boolean;
    includeUnknown: boolean;
  };
  viirs: {
    enabled: boolean;
    opacity: number;
    mode: ViewMode;
    live: boolean;
  };
  thermal: {
    enabled: boolean;
    opacity: number;
    source: "night_surface" | "air_temp" | "landsat_day";
    mode: ViewMode;
    hour: number;
    followClock: boolean;
    isPlaying?: boolean;
  };
  weather: {
    enabled: boolean;
    opacity: number;
    mode: ViewMode;
    hour: number;
    followClock: boolean;
    isPlaying?: boolean;
    live: boolean;
  };
}

export interface FacilityCounts {
  medicine: number;
  food: number;
  hospital: number;
  police: number;
}

type Props = {
  layersMeta: LayerMeta[];
  state: LayerState;
  onChange: (updater: (prev: LayerState) => LayerState) => void;
  counts: FacilityCounts;
  simHour: number;
  originLat?: number;
  originLon?: number;
  onRefreshMeta?: () => void;
};

// Render status chip with honest age and source
function renderStatusChip(chip: StatusChip | undefined, age_s: number | null | undefined, srcLabel?: string) {
  const c = chip || "CACHED";
  let bg = "bg-sky-500/20 text-sky-400 border-sky-500/40";
  let dot = "bg-sky-400";
  let pulse = false;

  if (c === "LIVE") {
    bg = "bg-emerald-500/20 text-emerald-400 border-emerald-500/40";
    dot = "bg-emerald-400";
    pulse = true;
  } else if (c === "STALE") {
    bg = "bg-amber-500/20 text-amber-400 border-amber-500/40";
    dot = "bg-amber-400";
  } else if (c === "OFFLINE") {
    bg = "bg-rose-500/20 text-rose-400 border-rose-500/40";
    dot = "bg-rose-400";
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[0.72rem]">
      <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-bold tracking-wide ${bg}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${dot} ${pulse ? "animate-ping" : ""}`} />
        <span>{c}</span>
      </span>
      {age_s !== undefined && age_s !== null && (
        <span className="font-mono text-soft/80">{ago(age_s)}</span>
      )}
      {srcLabel && (
        <span className="truncate text-[0.7rem] text-soft/60">· {srcLabel}</span>
      )}
    </div>
  );
}

// Small SVG Temperature Chart for tonight at user's origin
function OriginHourlyChart({ forecast }: { forecast: OriginForecastPoint[] }) {
  if (!forecast || forecast.length === 0) return null;
  // Slice to tonight (00:00 to 06:00)
  const items = forecast.slice(0, 7);
  const temps = items.map((f) => f.apparent_temperature ?? f.temperature_2m ?? 20);
  const minT = Math.floor(Math.min(...temps) - 1);
  const maxT = Math.ceil(Math.max(...temps) + 1);
  const range = Math.max(1, maxT - minT);

  const w = 320;
  const h = 70;
  const padX = 24;
  const padY = 14;

  const points = items.map((f, idx) => {
    const x = padX + (idx / Math.max(1, items.length - 1)) * (w - 2 * padX);
    const temp = f.apparent_temperature ?? f.temperature_2m ?? minT;
    const y = h - padY - ((temp - minT) / range) * (h - 2 * padY);
    return { x, y, hour: f.hour, temp: Math.round(temp * 10) / 10 };
  });

  const pathD = points.reduce((acc, p, idx) => `${acc} ${idx === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`, "");

  return (
    <div className="rounded-xl border border-edge/60 bg-night/70 p-3">
      <div className="flex items-center justify-between text-[0.75rem] font-semibold text-soft">
        <span>Tonight's hourly temperature (origin)</span>
        <span className="text-[0.7rem] text-soft/70">Open-Meteo</span>
      </div>
      <div className="relative mt-2 flex justify-center">
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full overflow-visible" aria-hidden="true">
          {/* Subtle grid line */}
          <line x1={padX} y1={h - padY} x2={w - padX} y2={h - padY} stroke="#334155" strokeWidth="1" strokeDasharray="2 2" />
          {/* Temperature curve */}
          <path d={pathD} fill="none" stroke="#8b7cff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          {/* Points with labels */}
          {points.map((p, i) => (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r="3.5" fill="#f4f6ff" stroke="#8b7cff" strokeWidth="2" />
              <text x={p.x} y={p.y - 7} fill="#c3cae6" fontSize="10" fontWeight="bold" textAnchor="middle">
                {p.temp}°
              </text>
              <text x={p.x} y={h - 2} fill="#64748b" fontSize="9" textAnchor="middle">
                {String(p.hour).padStart(2, "0")}h
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

export function LayerPanel({
  layersMeta,
  state,
  onChange,
  counts,
  simHour,
  originLat,
  originLon,
  onRefreshMeta,
}: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [infoLayer, setInfoLayer] = useState<LayerMeta | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [originForecast, setOriginForecast] = useState<OriginForecastPoint[]>([]);

  // Sync follow clock with simHour
  useEffect(() => {
    if (state.weather.followClock) {
      const clamped = Math.max(0, Math.min(6, simHour));
      if (clamped !== state.weather.hour) {
        onChange((prev) => ({
          ...prev,
          weather: { ...prev.weather, hour: clamped },
        }));
      }
    }
    if (state.thermal.followClock && state.thermal.source === "air_temp") {
      const clamped = Math.max(0, Math.min(6, simHour));
      if (clamped !== state.thermal.hour) {
        onChange((prev) => ({
          ...prev,
          thermal: { ...prev.thermal, hour: clamped },
        }));
      }
    }
  }, [simHour, state.weather.followClock, state.thermal.followClock, state.thermal.source, onChange]);

  // Hourly play timer for Weather
  useEffect(() => {
    if (!state.weather.isPlaying) return;
    const interval = window.setInterval(() => {
      onChange((prev) => ({
        ...prev,
        weather: {
          ...prev.weather,
          hour: (prev.weather.hour + 1) % 7,
        },
      }));
    }, 1500);
    return () => clearInterval(interval);
  }, [state.weather.isPlaying, onChange]);

  // Hourly play timer for Thermal (air_temp)
  useEffect(() => {
    if (!state.thermal.isPlaying || state.thermal.source !== "air_temp") return;
    const interval = window.setInterval(() => {
      onChange((prev) => ({
        ...prev,
        thermal: {
          ...prev.thermal,
          hour: (prev.thermal.hour + 1) % 7,
        },
      }));
    }, 1500);
    return () => clearInterval(interval);
  }, [state.thermal.isPlaying, state.thermal.source, onChange]);

  // Fetch origin forecast chart data when infoLayer opens
  useEffect(() => {
    if (!infoLayer) return;
    if (infoLayer.id === "weather_grid" || infoLayer.id === "thermal_lst") {
      api
        .weatherLayer("apparent_temperature", undefined, originLat, originLon)
        .then((res) => {
          if (res.origin_forecast) {
            setOriginForecast(res.origin_forecast);
          }
        })
        .catch(() => {});
    }
  }, [infoLayer, originLat, originLon]);

  const viirsMeta = layersMeta.find((l) => l.id === "viirs_ntl");
  const thermalMeta = layersMeta.find((l) => l.id === "thermal_lst");
  const weatherMeta = layersMeta.find((l) => l.id === "weather_grid");

  const anyActive =
    state.viirs.enabled ||
    state.thermal.enabled ||
    state.weather.enabled ||
    state.facilities.medicine ||
    state.facilities.food ||
    state.facilities.hospital ||
    state.facilities.police;

  // Manual refresh handler
  const handleRefresh = async (layerName: string) => {
    if (refreshing) return;
    setRefreshing(layerName);
    try {
      await api.refreshLayer(layerName);
      onRefreshMeta?.();
    } catch {
      // ignore rate limit or error
    } finally {
      window.setTimeout(() => setRefreshing(null), 800);
    }
  };

  return (
    <>
      {/* Floating Map Button with 44px min tap target */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={`fixed top-4 right-4 z-20 flex h-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-2xl border px-3 text-[0.88rem] font-bold shadow-xl backdrop-blur-md transition-all ${
          open || anyActive
            ? "border-accent bg-surface/95 text-ink ring-2 ring-accent/30"
            : "border-edge bg-surface/85 text-soft hover:text-ink"
        }`}
        aria-label={t("label.layers")}
        aria-expanded={open}
        title={t("label.layers")}
      >
        <span aria-hidden="true" className="mr-1.5 text-[1.1rem]">
          🗺️
        </span>
        <span>{t("label.layers")}</span>
        {anyActive && <span className="ml-1.5 h-2 w-2 rounded-full bg-accent" />}
      </button>

      {/* Layer Panel (compact floating on desktop, bottom sheet on mobile) */}
      {open && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 p-0 sm:items-start sm:justify-end sm:p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="scroll-quiet max-h-[88dvh] w-full max-w-[440px] overflow-y-auto rounded-t-3xl border border-edge bg-surface/98 p-4 shadow-2xl backdrop-blur-xl sm:mt-12 sm:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={t("label.layers")}
          >
            <div className="flex items-center justify-between border-b border-edge/60 pb-3">
              <div className="flex items-center gap-2">
                <span className="text-[1.2rem]">🗺️</span>
                <h2 className="text-[1.15rem] font-bold text-ink">{t("label.layers")}</h2>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="flex h-9 w-9 min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-edge text-soft hover:text-ink"
                aria-label={t("label.close")}
              >
                ✕
              </button>
            </div>

            <div className="mt-3 space-y-4">
              {/* Coverage outline & mask toggle */}
              <div className="flex items-center justify-between rounded-2xl bg-raised/70 p-3">
                <span className="font-semibold text-ink">{t("label.coverageArea")}</span>
                <button
                  onClick={() => onChange((prev) => ({ ...prev, showCoverage: !prev.showCoverage }))}
                  className={`min-h-[44px] rounded-xl px-3 py-1 text-[0.85rem] font-bold transition-colors ${
                    state.showCoverage ? "bg-good/20 text-good border border-good/40" : "bg-night/60 text-soft border border-edge"
                  }`}
                  aria-pressed={state.showCoverage}
                >
                  {state.showCoverage ? "ON" : "OFF"}
                </button>
              </div>

              {/* Facilities Section */}
              <div className="rounded-2xl border border-edge bg-raised/50 p-3">
                <div className="flex items-center justify-between pb-2">
                  <h3 className="font-bold text-ink">{t("label.facilities")}</h3>
                  <span className="text-[0.78rem] text-soft">OSM Places</span>
                </div>
                {/* 4 Category chips */}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  {(
                    [
                      { key: "medicine", label: t("label.medicine"), icon: "💊", count: counts.medicine },
                      { key: "food", label: t("label.food"), icon: "🍲", count: counts.food },
                      { key: "hospital", label: t("label.hospital"), icon: "🏥", count: counts.hospital },
                      { key: "police", label: t("label.police"), icon: "👮", count: counts.police },
                    ] as const
                  ).map((item) => {
                    const active = state.facilities[item.key];
                    return (
                      <button
                        key={item.key}
                        onClick={() =>
                          onChange((prev) => ({
                            ...prev,
                            facilities: { ...prev.facilities, [item.key]: !active },
                          }))
                        }
                        className={`flex min-h-[44px] items-center justify-between rounded-xl border px-2.5 py-1 text-[0.85rem] font-semibold transition-colors ${
                          active
                            ? "border-accent bg-accent/20 text-ink ring-1 ring-accent"
                            : "border-edge bg-surface/70 text-soft hover:text-ink"
                        }`}
                        aria-pressed={active}
                      >
                        <span className="flex items-center gap-1.5 truncate">
                          <span>{item.icon}</span>
                          <span className="truncate">{item.label}</span>
                        </span>
                        <span className="ml-1 rounded-full bg-night/70 px-1.5 py-0.5 text-[0.72rem] text-soft">
                          {item.count}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Hours filters */}
                <div className="mt-3 flex items-center justify-between gap-2 border-t border-edge/60 pt-2.5">
                  <button
                    onClick={() =>
                      onChange((prev) => ({
                        ...prev,
                        facilities: { ...prev.facilities, openOnly: !prev.facilities.openOnly },
                      }))
                    }
                    className={`flex min-h-[44px] flex-1 items-center justify-center rounded-xl border px-2 py-1 text-[0.8rem] font-semibold transition-colors ${
                      state.facilities.openOnly
                        ? "border-good bg-good/20 text-good"
                        : "border-edge bg-surface/60 text-soft"
                    }`}
                    aria-pressed={state.facilities.openOnly}
                  >
                    <span>{t("label.openAtThisTime")}</span>
                  </button>

                  <button
                    onClick={() =>
                      onChange((prev) => ({
                        ...prev,
                        facilities: { ...prev.facilities, includeUnknown: !prev.facilities.includeUnknown },
                      }))
                    }
                    className={`flex min-h-[44px] flex-1 items-center justify-center rounded-xl border border-dashed px-2 py-1 text-[0.8rem] font-semibold transition-colors ${
                      state.facilities.includeUnknown
                        ? "border-soft bg-surface text-ink"
                        : "border-edge/50 bg-night/40 text-soft/60"
                    }`}
                    aria-pressed={state.facilities.includeUnknown}
                  >
                    <span>{t("label.includeUnknownHours")}</span>
                  </button>
                </div>
              </div>

              {/* Night Lights (VIIRS) */}
              <div className="rounded-2xl border border-edge bg-raised/50 p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-ink">{t("label.nightLights")}</span>
                    {viirsMeta && (
                      <button
                        onClick={() => setInfoLayer(viirsMeta)}
                        className="flex h-7 w-7 min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-[0.9rem] text-soft hover:text-accent"
                        aria-label={t("label.layerInfo")}
                        title={t("label.layerInfo")}
                      >
                        ℹ️
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() =>
                      onChange((prev) => ({
                        ...prev,
                        viirs: { ...prev.viirs, enabled: !prev.viirs.enabled },
                      }))
                    }
                    className={`min-h-[44px] rounded-xl px-3 py-1 text-[0.85rem] font-bold transition-colors ${
                      state.viirs.enabled
                        ? "bg-good/20 text-good border border-good/40"
                        : "bg-night/60 text-soft border border-edge"
                    }`}
                    aria-pressed={state.viirs.enabled}
                  >
                    {state.viirs.enabled ? "ON" : "OFF"}
                  </button>
                </div>

                {/* Status chip and Age */}
                <div className="mt-1.5 flex items-center justify-between">
                  {renderStatusChip(viirsMeta?.status_chip, viirsMeta?.age_s, "NASA Black Marble")}
                  {/* Manual Refresh button */}
                  <button
                    disabled={refreshing === "night_lights"}
                    onClick={() => handleRefresh("night_lights")}
                    className="flex min-h-[36px] items-center gap-1 rounded-lg border border-edge px-2 py-0.5 text-[0.72rem] font-medium text-soft hover:text-ink disabled:opacity-50"
                    title={t("label.refresh")}
                  >
                    <span className={refreshing === "night_lights" ? "animate-spin" : ""}>🔄</span>
                    <span>{t("label.refresh")}</span>
                  </button>
                </div>

                {state.viirs.enabled && (
                  <div className="mt-3 space-y-2.5 border-t border-edge/60 pt-2.5">
                    {/* View Mode 3-way switch (Streets, Smooth, Cells) */}
                    <div>
                      <div className="mb-1 text-[0.75rem] font-semibold text-soft">View Mode</div>
                      <div className="grid grid-cols-3 gap-1">
                        {(["streets", "smooth", "cells"] as const).map((mode) => (
                          <button
                            key={mode}
                            onClick={() => {
                              try { localStorage.setItem("nw_view_mode_viirs", mode); } catch {}
                              onChange((prev) => ({ ...prev, viirs: { ...prev.viirs, mode } }));
                            }}
                            className={`flex min-h-[44px] items-center justify-center rounded-xl border text-[0.8rem] font-bold capitalize transition-colors ${
                              state.viirs.mode === mode
                                ? "border-accent bg-accent/25 text-ink ring-1 ring-accent"
                                : "border-edge bg-surface text-soft hover:text-ink"
                            }`}
                          >
                            {t(`label.${mode}` as any)}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Opacity */}
                    <div className="flex items-center justify-between text-[0.8rem] text-soft">
                      <span>{t("label.opacity")}</span>
                      <span>{Math.round(state.viirs.opacity * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.1"
                      max="1"
                      step="0.05"
                      value={state.viirs.opacity}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        try { localStorage.setItem("nw_opacity_viirs", String(val)); } catch {}
                        onChange((prev) => ({ ...prev, viirs: { ...prev.viirs, opacity: val } }));
                      }}
                      className="h-2 w-full cursor-pointer accent-accent"
                    />

                    {/* Colour Scale Legend */}
                    <div className="pt-1">
                      <div
                        className="h-3 w-full rounded-md"
                        style={{
                          background: "linear-gradient(to right, #050510, #1a1e4a, #2b3990, #5a5db8, #ffd700, #ffffff)",
                        }}
                      />
                      <div className="mt-0.5 flex justify-between text-[0.72rem] text-soft">
                        <span>Low (0)</span>
                        <span>Radiance (nW·cm⁻²·sr⁻¹)</span>
                        <span>High (110+)</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Thermal Layer */}
              <div className="rounded-2xl border border-edge bg-raised/50 p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-ink">{t("label.thermal")}</span>
                    {thermalMeta && (
                      <button
                        onClick={() => setInfoLayer(thermalMeta)}
                        className="flex h-7 w-7 min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-[0.9rem] text-soft hover:text-accent"
                        aria-label={t("label.layerInfo")}
                        title={t("label.layerInfo")}
                      >
                        ℹ️
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() =>
                      onChange((prev) => ({
                        ...prev,
                        thermal: { ...prev.thermal, enabled: !prev.thermal.enabled },
                      }))
                    }
                    className={`min-h-[44px] rounded-xl px-3 py-1 text-[0.85rem] font-bold transition-colors ${
                      state.thermal.enabled
                        ? "bg-good/20 text-good border border-good/40"
                        : "bg-night/60 text-soft border border-edge"
                    }`}
                    aria-pressed={state.thermal.enabled}
                  >
                    {state.thermal.enabled ? "ON" : "OFF"}
                  </button>
                </div>

                {/* Status chip */}
                <div className="mt-1.5 flex items-center justify-between">
                  {renderStatusChip(
                    thermalMeta?.status_chip,
                    thermalMeta?.age_s,
                    state.thermal.source === "air_temp" ? "Open-Meteo" : "MODIS Aqua LST"
                  )}
                  {state.thermal.source === "air_temp" && (
                    <button
                      disabled={refreshing === "weather"}
                      onClick={() => handleRefresh("weather")}
                      className="flex min-h-[36px] items-center gap-1 rounded-lg border border-edge px-2 py-0.5 text-[0.72rem] font-medium text-soft hover:text-ink disabled:opacity-50"
                      title={t("label.refresh")}
                    >
                      <span className={refreshing === "weather" ? "animate-spin" : ""}>🔄</span>
                      <span>{t("label.refresh")}</span>
                    </button>
                  )}
                </div>

                {state.thermal.enabled && (
                  <div className="mt-3 space-y-2.5 border-t border-edge/60 pt-2.5">
                    {/* Source Switch */}
                    <div className="grid grid-cols-3 gap-1">
                      <button
                        onClick={() => onChange((prev) => ({ ...prev, thermal: { ...prev.thermal, source: "night_surface" } }))}
                        className={`min-h-[44px] rounded-xl border px-1.5 py-1 text-[0.75rem] font-bold ${
                          state.thermal.source === "night_surface"
                            ? "border-accent bg-accent/25 text-ink ring-1 ring-accent"
                            : "border-edge bg-surface text-soft hover:text-ink"
                        }`}
                      >
                        {t("label.nightSurface")}
                      </button>
                      <button
                        onClick={() => onChange((prev) => ({ ...prev, thermal: { ...prev.thermal, source: "air_temp" } }))}
                        className={`min-h-[44px] rounded-xl border px-1.5 py-1 text-[0.75rem] font-bold ${
                          state.thermal.source === "air_temp"
                            ? "border-accent bg-accent/25 text-ink ring-1 ring-accent"
                            : "border-edge bg-surface text-soft hover:text-ink"
                        }`}
                      >
                        {t("label.airTemp")}
                      </button>
                      <button
                        disabled
                        className="min-h-[44px] cursor-not-allowed rounded-xl border border-edge/40 bg-night/50 px-1.5 py-1 text-[0.75rem] text-soft/40"
                        title={t("line.daytimeLandsatNote")}
                      >
                        {t("label.daySurface")}
                      </button>
                    </div>

                    {/* View Mode 3-way switch */}
                    <div>
                      <div className="mb-1 text-[0.75rem] font-semibold text-soft">View Mode</div>
                      <div className="grid grid-cols-3 gap-1">
                        {(["streets", "smooth", "cells"] as const).map((mode) => (
                          <button
                            key={mode}
                            onClick={() => {
                              try { localStorage.setItem("nw_view_mode_thermal", mode); } catch {}
                              onChange((prev) => ({ ...prev, thermal: { ...prev.thermal, mode } }));
                            }}
                            className={`flex min-h-[44px] items-center justify-center rounded-xl border text-[0.8rem] font-bold capitalize transition-colors ${
                              state.thermal.mode === mode
                                ? "border-accent bg-accent/25 text-ink ring-1 ring-accent"
                                : "border-edge bg-surface text-soft hover:text-ink"
                            }`}
                          >
                            {t(`label.${mode}` as any)}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Time scrubber when Air Temperature is selected */}
                    {state.thermal.source === "air_temp" && (
                      <div className="rounded-xl border border-edge/80 bg-night/60 p-2.5 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[0.82rem] font-semibold text-ink">
                            Hour: {String(state.thermal.hour).padStart(2, "0")}:00
                          </span>
                          <div className="flex items-center gap-1.5">
                            {/* Play/Pause Button */}
                            <button
                              onClick={() =>
                                onChange((prev) => ({
                                  ...prev,
                                  thermal: { ...prev.thermal, isPlaying: !prev.thermal.isPlaying, followClock: false },
                                }))
                              }
                              className="flex min-h-[36px] items-center gap-1 rounded-lg border border-edge px-2 py-0.5 text-[0.75rem] font-bold text-ink hover:bg-surface"
                            >
                              <span>{state.thermal.isPlaying ? "⏸️" : "▶️"}</span>
                              <span>{state.thermal.isPlaying ? t("label.pause") : t("label.play")}</span>
                            </button>
                            {/* Follow Clock */}
                            <button
                              onClick={() =>
                                onChange((prev) => ({
                                  ...prev,
                                  thermal: { ...prev.thermal, followClock: !prev.thermal.followClock, isPlaying: false },
                                }))
                              }
                              className={`min-h-[36px] rounded-lg border px-2 py-0.5 text-[0.72rem] font-bold ${
                                state.thermal.followClock ? "border-accent bg-accent/25 text-ink" : "border-edge bg-surface text-soft"
                              }`}
                              aria-pressed={state.thermal.followClock}
                            >
                              {t("label.followClock")}
                            </button>
                          </div>
                        </div>

                        <input
                          type="range"
                          min="0"
                          max="6"
                          step="1"
                          value={state.thermal.hour}
                          disabled={state.thermal.followClock}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10);
                            onChange((prev) => ({
                              ...prev,
                              thermal: { ...prev.thermal, hour: val, isPlaying: false },
                            }));
                          }}
                          className="h-2 w-full cursor-pointer accent-accent disabled:opacity-40"
                        />
                        <div className="flex justify-between text-[0.72rem] text-soft">
                          <span>00:00</span>
                          <span>02:00</span>
                          <span>04:00</span>
                          <span>06:00</span>
                        </div>
                      </div>
                    )}

                    {/* Opacity */}
                    <div className="flex items-center justify-between text-[0.8rem] text-soft">
                      <span>{t("label.opacity")}</span>
                      <span>{Math.round(state.thermal.opacity * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.1"
                      max="1"
                      step="0.05"
                      value={state.thermal.opacity}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        try { localStorage.setItem("nw_opacity_thermal", String(val)); } catch {}
                        onChange((prev) => ({ ...prev, thermal: { ...prev.thermal, opacity: val } }));
                      }}
                      className="h-2 w-full cursor-pointer accent-accent"
                    />

                    {/* Thermal Legend */}
                    <div className="pt-1">
                      <div
                        className="h-3 w-full rounded-md"
                        style={{
                          background:
                            "linear-gradient(to right, #313695, #4575b4, #74add1, #abd9e9, #fee090, #fdae61, #f46d43, #d73027)",
                        }}
                      />
                      <div className="mt-0.5 flex justify-between text-[0.72rem] text-soft">
                        <span>Cool (15°C)</span>
                        <span>Surface / Air Temp (°C)</span>
                        <span>Warm (35°C+)</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Weather Layer */}
              <div className="rounded-2xl border border-edge bg-raised/50 p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-ink">{t("label.weather")}</span>
                    {weatherMeta && (
                      <button
                        onClick={() => setInfoLayer(weatherMeta)}
                        className="flex h-7 w-7 min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-[0.9rem] text-soft hover:text-accent"
                        aria-label={t("label.layerInfo")}
                        title={t("label.layerInfo")}
                      >
                        ℹ️
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() =>
                      onChange((prev) => ({
                        ...prev,
                        weather: { ...prev.weather, enabled: !prev.weather.enabled },
                      }))
                    }
                    className={`min-h-[44px] rounded-xl px-3 py-1 text-[0.85rem] font-bold transition-colors ${
                      state.weather.enabled
                        ? "bg-good/20 text-good border border-good/40"
                        : "bg-night/60 text-soft border border-edge"
                    }`}
                    aria-pressed={state.weather.enabled}
                  >
                    {state.weather.enabled ? "ON" : "OFF"}
                  </button>
                </div>

                {/* Status chip */}
                <div className="mt-1.5 flex items-center justify-between">
                  {renderStatusChip(weatherMeta?.status_chip, weatherMeta?.age_s, "Open-Meteo")}
                  {/* Manual Refresh button */}
                  <button
                    disabled={refreshing === "weather"}
                    onClick={() => handleRefresh("weather")}
                    className="flex min-h-[36px] items-center gap-1 rounded-lg border border-edge px-2 py-0.5 text-[0.72rem] font-medium text-soft hover:text-ink disabled:opacity-50"
                    title={t("label.refresh")}
                  >
                    <span className={refreshing === "weather" ? "animate-spin" : ""}>🔄</span>
                    <span>{t("label.refresh")}</span>
                  </button>
                </div>

                {state.weather.enabled && (
                  <div className="mt-3 space-y-2.5 border-t border-edge/60 pt-2.5">
                    {/* View Mode 3-way switch */}
                    <div>
                      <div className="mb-1 text-[0.75rem] font-semibold text-soft">View Mode</div>
                      <div className="grid grid-cols-3 gap-1">
                        {(["streets", "smooth", "cells"] as const).map((mode) => (
                          <button
                            key={mode}
                            onClick={() => {
                              try { localStorage.setItem("nw_view_mode_weather", mode); } catch {}
                              onChange((prev) => ({ ...prev, weather: { ...prev.weather, mode } }));
                            }}
                            className={`flex min-h-[44px] items-center justify-center rounded-xl border text-[0.8rem] font-bold capitalize transition-colors ${
                              state.weather.mode === mode
                                ? "border-accent bg-accent/25 text-ink ring-1 ring-accent"
                                : "border-edge bg-surface text-soft hover:text-ink"
                            }`}
                          >
                            {t(`label.${mode}` as any)}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Time scrubber with Play/Pause button */}
                    <div className="rounded-xl border border-edge/80 bg-night/60 p-2.5 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[0.82rem] font-semibold text-ink">
                          Hour: {String(state.weather.hour).padStart(2, "0")}:00
                        </span>
                        <div className="flex items-center gap-1.5">
                          {/* Play/Pause Button */}
                          <button
                            onClick={() =>
                              onChange((prev) => ({
                                ...prev,
                                weather: { ...prev.weather, isPlaying: !prev.weather.isPlaying, followClock: false },
                              }))
                            }
                            className="flex min-h-[36px] items-center gap-1 rounded-lg border border-edge px-2 py-0.5 text-[0.75rem] font-bold text-ink hover:bg-surface"
                          >
                            <span>{state.weather.isPlaying ? "⏸️" : "▶️"}</span>
                            <span>{state.weather.isPlaying ? t("label.pause") : t("label.play")}</span>
                          </button>
                          {/* Follow Clock */}
                          <button
                            onClick={() =>
                              onChange((prev) => ({
                                ...prev,
                                weather: { ...prev.weather, followClock: !prev.weather.followClock, isPlaying: false },
                              }))
                            }
                            className={`min-h-[36px] rounded-lg border px-2 py-0.5 text-[0.72rem] font-bold ${
                              state.weather.followClock ? "border-accent bg-accent/25 text-ink" : "border-edge bg-surface text-soft"
                            }`}
                            aria-pressed={state.weather.followClock}
                          >
                            {t("label.followClock")}
                          </button>
                        </div>
                      </div>

                      <input
                        type="range"
                        min="0"
                        max="6"
                        step="1"
                        value={state.weather.hour}
                        disabled={state.weather.followClock}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10);
                          onChange((prev) => ({
                            ...prev,
                            weather: { ...prev.weather, hour: val, isPlaying: false },
                          }));
                        }}
                        className="h-2 w-full cursor-pointer accent-accent disabled:opacity-40"
                      />
                      <div className="flex justify-between text-[0.72rem] text-soft">
                        <span>00:00</span>
                        <span>02:00</span>
                        <span>04:00</span>
                        <span>06:00</span>
                      </div>
                    </div>

                    {/* Opacity */}
                    <div className="flex items-center justify-between text-[0.8rem] text-soft">
                      <span>{t("label.opacity")}</span>
                      <span>{Math.round(state.weather.opacity * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.1"
                      max="1"
                      step="0.05"
                      value={state.weather.opacity}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        try { localStorage.setItem("nw_opacity_weather", String(val)); } catch {}
                        onChange((prev) => ({ ...prev, weather: { ...prev.weather, opacity: val } }));
                      }}
                      className="h-2 w-full cursor-pointer accent-accent"
                    />

                    {/* Temperature legend */}
                    <div className="pt-1">
                      <div
                        className="h-3 w-full rounded-md"
                        style={{
                          background:
                            "linear-gradient(to right, #313695, #4575b4, #74add1, #abd9e9, #fee090, #fdae61, #f46d43, #d73027)",
                        }}
                      />
                      <div className="mt-0.5 flex justify-between text-[0.72rem] text-soft">
                        <span>15°C</span>
                        <span>Forecast Temperature</span>
                        <span>35°C</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Info Sheet Modal / Bottom Sheet */}
      {infoLayer && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setInfoLayer(null)}
        >
          <div
            className="scroll-quiet max-h-[85dvh] w-full max-w-[480px] overflow-y-auto rounded-3xl border border-edge bg-surface p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={infoLayer.name}
          >
            <div className="flex items-center justify-between border-b border-edge/60 pb-3">
              <h2 className="text-[1.2rem] font-bold text-ink">{infoLayer.name}</h2>
              <button
                onClick={() => setInfoLayer(null)}
                className="flex h-9 w-9 min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-edge text-soft hover:text-ink"
                aria-label={t("label.close")}
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-3 text-[0.88rem]">
              {/* Status and Age */}
              <div className="flex items-center justify-between rounded-xl bg-raised p-2.5">
                <span className="text-soft">Status & Age</span>
                <div className="flex items-center gap-2">
                  {renderStatusChip(infoLayer.status_chip, infoLayer.age_s, infoLayer.source)}
                </div>
              </div>

              {/* Astronomical Moon Illumination for Night Lights */}
              {infoLayer.id === "viirs_ntl" && (
                <div className="rounded-xl border border-edge/80 bg-raised/90 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-ink flex items-center gap-1.5">
                      <span>🌕</span>
                      <span>Moon Illumination Tonight</span>
                    </span>
                    <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[0.7rem] font-semibold text-accent">
                      computed, not measured
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 pt-1 text-[0.8rem]">
                    <div className="rounded-lg bg-surface/70 p-2">
                      <div className="text-soft text-[0.72rem]">Phase</div>
                      <div className="font-bold text-ink">{infoLayer.moon_illumination?.phase_name || "Full Moon"}</div>
                    </div>
                    <div className="rounded-lg bg-surface/70 p-2">
                      <div className="text-soft text-[0.72rem]">Illuminated</div>
                      <div className="font-bold text-good">{infoLayer.moon_illumination?.percent ?? 99.7}%</div>
                    </div>
                  </div>
                  <div className="text-[0.72rem] text-soft/80 italic">
                    Astronomical lunar illumination calculated for the demo night. For display only; not fed into risk scoring.
                  </div>
                  {/* Last satellite pass */}
                  <div className="mt-1 pt-2 border-t border-edge/50 flex items-center justify-between text-[0.78rem]">
                    <span className="text-soft">Last satellite pass:</span>
                    <span className="font-semibold text-ink">
                      {infoLayer.last_pass_date ? `${infoLayer.last_pass_date} (${infoLayer.days_ago ?? 0} days ago)` : infoLayer.last_satellite_pass || "Recent pass"}
                    </span>
                  </div>
                </div>
              )}

              {/* Thermal Microclimate Note */}
              {(infoLayer.id === "thermal_lst" || infoLayer.id === "weather_grid") && (
                <div className="rounded-xl border border-edge/80 bg-raised/90 p-3 space-y-2">
                  <div className="text-[0.78rem] font-bold text-ink">Microclimate & Spatial Resolution Note</div>
                  <div className="text-[0.8rem] text-soft leading-relaxed">
                    Air temperature varies by less than ~1-2°C across this 7x7 km area because regional atmospheric mixing dominates at 2 km grid scale, whereas satellite land surface temperature (LST) captures sharp thermal variations between asphalt, dense buildings, and open vegetation.
                  </div>
                  {/* Origin forecast SVG chart */}
                  {originForecast.length > 0 && (
                    <div className="pt-2">
                      <OriginHourlyChart forecast={originForecast} />
                    </div>
                  )}
                </div>
              )}

              <div className="rounded-xl bg-raised p-2.5">
                <div className="text-[0.75rem] text-soft">{t("label.source")}</div>
                <div className="font-semibold text-ink">{infoLayer.source}</div>
                {infoLayer.product && (
                  <div className="mt-0.5 text-[0.8rem] text-soft">{infoLayer.product}</div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl bg-raised p-2.5">
                  <div className="text-[0.75rem] text-soft">Valid Date Range</div>
                  <div className="font-medium text-ink">{infoLayer.date_range || "N/A"}</div>
                </div>
                <div className="rounded-xl bg-raised p-2.5">
                  <div className="text-[0.75rem] text-soft">{t("label.nativeRes")}</div>
                  <div className="font-medium text-ink">{infoLayer.native_resolution}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl bg-raised p-2.5">
                  <div className="text-[0.75rem] text-soft">Retrieved At</div>
                  <div className="font-mono text-[0.78rem] text-ink">{infoLayer.retrieved_at ? infoLayer.retrieved_at.slice(0, 19) + "Z" : "N/A"}</div>
                </div>
                <div className="rounded-xl bg-raised p-2.5">
                  <div className="text-[0.75rem] text-soft">{t("label.unknownShare")}</div>
                  <div className="font-bold text-good">{infoLayer.unknown_share}%</div>
                </div>
              </div>

              <div className="rounded-xl bg-raised p-2.5">
                <div className="text-[0.75rem] text-soft">{t("label.license")} & Attribution</div>
                <div className="text-[0.8rem] font-medium text-ink">{infoLayer.license}</div>
                <div className="mt-1 text-[0.78rem] text-soft">{infoLayer.attribution}</div>
              </div>

              <div className="rounded-xl bg-raised/80 p-3">
                <div className="text-[0.78rem] font-bold text-ink">What this layer shows & limits</div>
                <div className="mt-1 text-[0.82rem] leading-relaxed text-soft">{infoLayer.note}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

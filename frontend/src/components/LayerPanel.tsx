import { useEffect, useState } from "react";
import { useT } from "../copy";
import type { LayerMeta } from "../types";
import { OFFICIAL, ago } from "../demo/demoApi";

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
  };
  thermal: {
    enabled: boolean;
    opacity: number;
    source: "night_surface" | "air_temp" | "landsat_day";
  };
  weather: {
    enabled: boolean;
    opacity: number;
    hour: number;
    followClock: boolean;
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
};

export function LayerPanel({ layersMeta, state, onChange, counts, simHour }: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [infoLayer, setInfoLayer] = useState<LayerMeta | null>(null);

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
  }, [simHour, state.weather.followClock, state.weather.hour, onChange]);

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
            className="scroll-quiet max-h-[85dvh] w-full max-w-[420px] overflow-y-auto rounded-t-3xl border border-edge bg-surface/98 p-4 shadow-2xl backdrop-blur-xl sm:mt-12 sm:rounded-3xl"
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
                        className="flex h-6 w-6 min-h-[30px] min-w-[30px] items-center justify-center rounded-full text-[0.8rem] text-soft hover:text-accent"
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

                {state.viirs.enabled && (
                  <div className="mt-3 space-y-2 border-t border-edge/60 pt-2.5">
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
                        onChange((prev) => ({ ...prev, viirs: { ...prev.viirs, opacity: val } }));
                      }}
                      className="h-2 w-full cursor-pointer accent-accent"
                    />
                    {/* Colour Scale Legend */}
                    <div className="pt-1">
                      <div className="h-3 w-full rounded-md" style={{
                        background: "linear-gradient(to right, #050510, #1a1e4a, #2b3990, #5a5db8, #ffd700, #ffffff)"
                      }} />
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
                        className="flex h-6 w-6 min-h-[30px] min-w-[30px] items-center justify-center rounded-full text-[0.8rem] text-soft hover:text-accent"
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

                {state.thermal.enabled && (
                  <div className="mt-3 space-y-2 border-t border-edge/60 pt-2.5">
                    {/* Source Switch */}
                    <div className="grid grid-cols-3 gap-1">
                      <button
                        onClick={() => onChange((prev) => ({ ...prev, thermal: { ...prev.thermal, source: "night_surface" } }))}
                        className={`min-h-[40px] rounded-lg border px-1.5 py-1 text-[0.75rem] font-bold ${
                          state.thermal.source === "night_surface"
                            ? "border-accent bg-accent/25 text-ink"
                            : "border-edge bg-surface text-soft"
                        }`}
                      >
                        {t("label.nightSurface")}
                      </button>
                      <button
                        onClick={() => onChange((prev) => ({ ...prev, thermal: { ...prev.thermal, source: "air_temp" } }))}
                        className={`min-h-[40px] rounded-lg border px-1.5 py-1 text-[0.75rem] font-bold ${
                          state.thermal.source === "air_temp"
                            ? "border-accent bg-accent/25 text-ink"
                            : "border-edge bg-surface text-soft"
                        }`}
                      >
                        {t("label.airTemp")}
                      </button>
                      <button
                        disabled
                        className="min-h-[40px] cursor-not-allowed rounded-lg border border-edge/40 bg-night/50 px-1.5 py-1 text-[0.75rem] text-soft/40"
                        title={t("line.daytimeLandsatNote")}
                      >
                        {t("label.daySurface")}
                      </button>
                    </div>

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
                        onChange((prev) => ({ ...prev, thermal: { ...prev.thermal, opacity: val } }));
                      }}
                      className="h-2 w-full cursor-pointer accent-accent"
                    />

                    {/* Thermal Legend */}
                    <div className="pt-1">
                      <div className="h-3 w-full rounded-md" style={{
                        background: "linear-gradient(to right, #313695, #4575b4, #74add1, #abd9e9, #fee090, #fdae61, #f46d43, #d73027)"
                      }} />
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
                        className="flex h-6 w-6 min-h-[30px] min-w-[30px] items-center justify-center rounded-full text-[0.8rem] text-soft hover:text-accent"
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

                {state.weather.enabled && (
                  <div className="mt-3 space-y-2.5 border-t border-edge/60 pt-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[0.85rem] font-semibold text-ink">
                        Hour: {String(state.weather.hour).padStart(2, "0")}:00
                      </span>
                      <button
                        onClick={() =>
                          onChange((prev) => ({
                            ...prev,
                            weather: { ...prev.weather, followClock: !prev.weather.followClock },
                          }))
                        }
                        className={`min-h-[36px] rounded-lg border px-2.5 py-0.5 text-[0.75rem] font-bold ${
                          state.weather.followClock
                            ? "border-accent bg-accent/25 text-ink"
                            : "border-edge bg-surface text-soft"
                        }`}
                        aria-pressed={state.weather.followClock}
                      >
                        {t("label.followClock")}
                      </button>
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
                        onChange((prev) => ({ ...prev, weather: { ...prev.weather, hour: val } }));
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
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Info Sheet Modal */}
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
              <div className="flex items-center justify-between rounded-xl bg-raised p-2.5">
                <span className="text-soft">Status & Age</span>
                <div className="flex items-center gap-2">
                  <span
                    className="rounded-md px-2 py-0.5 text-[0.78rem] font-bold"
                    style={{
                      backgroundColor: `${OFFICIAL[infoLayer.status]?.color || "#c3cae6"}22`,
                      color: OFFICIAL[infoLayer.status]?.color || "#c3cae6",
                    }}
                  >
                    {OFFICIAL[infoLayer.status]?.word || infoLayer.status}
                  </span>
                  <span className="font-mono text-soft">{ago(infoLayer.age_s)}</span>
                </div>
              </div>

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

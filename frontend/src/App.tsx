import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useT, type CopyKey } from "./copy";
import { MapCanvas } from "./components/MapCanvas";
import { LayerPanel, type LayerState, type FacilityCounts } from "./components/LayerPanel";
import { BackButton, Banner, Pill } from "./components/ui";
import { useConnection } from "./lib/connection";
import { isInsideCoverage, lastTrip, loadPlace, myLocation, rememberTrip, savePlace } from "./lib/saved";
import { Home, NEEDS } from "./screens/Home";
import { OpenNow } from "./screens/OpenNow";
import { Result } from "./screens/Result";
import { Search } from "./screens/Search";
import { HelpSheet, Trip } from "./screens/Trip";
import { CompareRoutesSheet } from "./components/CompareRoutesSheet";
import type { AppConfig, AreaDiagnostics, LatLon, LayerMeta, Place, PlaceOnWay, RouteItem, SimpleView } from "./types";

// Judges only: code-split, never in the first download (UI_SPEC §1.9, §5).
const DemoDrawer = lazy(() => import("./demo/DemoDrawer"));
const ScenariosPage = lazy(() => import("./demo/ScenariosPage"));
const SHOW_DEMO = import.meta.env.VITE_SHOW_DEMO === "true";

type Screen = "home" | "search" | "pick" | "result" | "trip" | "opennow";
const ll = (p: Place | null): LatLon | null => (p ? [p.lat, p.lon] : null);

export default function App() {
  if (window.location.pathname.startsWith("/scenarios")) {
    return <Suspense fallback={null}><ScenariosPage /></Suspense>;
  }
  return <Main />;
}

function getSavedViewMode(layer: string, fallback: "streets" | "smooth" | "cells"): "streets" | "smooth" | "cells" {
  try {
    const val = localStorage.getItem(`nw_view_mode_${layer}`);
    if (val === "streets" || val === "smooth" || val === "cells") return val;
  } catch {}
  return fallback;
}

function getSavedOpacity(layer: string, fallback: number): number {
  try {
    const val = localStorage.getItem(`nw_opacity_${layer}`);
    if (val !== null) {
      const num = parseFloat(val);
      if (!isNaN(num) && num >= 0.1 && num <= 1.0) return num;
    }
  } catch {}
  return fallback;
}

function Main() {
  const { t, lang } = useT();
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [diagnostics, setDiagnostics] = useState<AreaDiagnostics | null>(null);
  const [showCoverage, setShowCoverage] = useState(true);
  const [showDataCoverage, setShowDataCoverage] = useState(false);
  const [layersMeta, setLayersMeta] = useState<LayerMeta[]>([]);
  const [layerVersion, setLayerVersion] = useState(0);
  const [facilityCounts, setFacilityCounts] = useState<FacilityCounts>({
    medicine: 0,
    food: 0,
    hospital: 0,
    police: 0,
  });
  const [layerState, setLayerState] = useState<LayerState>({
    showCoverage: true,
    facilities: {
      medicine: false,
      food: false,
      hospital: false,
      police: false,
      openOnly: false,
      includeUnknown: true,
    },
    viirs: {
      enabled: false,
      opacity: getSavedOpacity("viirs", 0.75),
      mode: getSavedViewMode("viirs", "streets"),
      live: false,
    },
    thermal: {
      enabled: false,
      opacity: getSavedOpacity("thermal", 0.75),
      source: "night_surface",
      mode: getSavedViewMode("thermal", "cells"),
      hour: 2,
      followClock: true,
    },
    weather: {
      enabled: false,
      opacity: getSavedOpacity("weather", 0.75),
      mode: getSavedViewMode("weather", "cells"),
      hour: 2,
      followClock: true,
      live: false,
    },
  });
  const [from, setFrom] = useState<Place | null>(null);
  const [to, setTo] = useState<Place | null>(null);
  const [home, setHome] = useState<Place | null>(null);
  const [work, setWork] = useState<Place | null>(null);
  const [when, setWhen] = useState<string | null>(null);
  const [by, setBy] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [field, setField] = useState<"from" | "to">("to");
  const [pickSave, setPickSave] = useState<"home" | "work" | null>(null);
  const [view, setView] = useState<SimpleView | null>(null);
  const [shownId, setShownId] = useState("safest");
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [need, setNeed] = useState<{ type: string; title: string; places: PlaceOnWay[] | null; empty: string | null } | null>(null);
  const [showPlaces, setShowPlaces] = useState(false);
  const [helpAt, setHelpAt] = useState<Place | null>(null);
  const [sheetH, setSheetH] = useState(380);
  const [bannerId, setBannerId] = useState<string | null>(null);
  const [demoOpen, setDemoOpen] = useState(false);
  const [routes, setRoutes] = useState<RouteItem[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [showCompare, setShowCompare] = useState(false);
  const [showDominatedRoutes, setShowDominatedRoutes] = useState(false);
  const seen = useRef(new Set<string>());
  const conn = useConnection(view?.connection ?? null);

  useEffect(() => {
    setShowCoverage(layerState.showCoverage);
  }, [layerState.showCoverage]);

  // ---- multi-route alternatives for active plan ------------------------------------------------
  useEffect(() => {
    if (!view?.id) {
      setRoutes([]);
      setSelectedRouteId(null);
      return;
    }
    api.planRoutes(view.id)
      .then((res) => {
        setRoutes(res.routes || []);
        const rec = res.routes?.find((r) => r.recommended);
        if (rec) setSelectedRouteId((curr) => curr || rec.id);
      })
      .catch(() => {});
  }, [view?.id]);

  // ---- boot --------------------------------------------------------------------------------
  useEffect(() => {
    let stop = false;
    const boot = () => api.config().then(async (c) => {
      if (stop) return;
      setCfg(c);
      setHome(loadPlace("home", c.ui_defaults));
      setWork(loadPlace("work", c.ui_defaults));
      setBy(c.ui_defaults.deadline);
      setFrom(await myLocation(c.ui_defaults, c.center, c.radius_m, c.polygon));
      api.areaDiagnostics().then((diag) => { if (!stop) setDiagnostics(diag); }).catch(() => {});
      api.layers().then((res) => { if (!stop) setLayersMeta(res); }).catch(() => {});
      // a shared link, or a trip this phone already started: carry on with it (from cache if no signal)
      const trip = new URLSearchParams(window.location.search).get("trip") || lastTrip();
      if (trip) {
        api.getPlan(trip, lang).then((v) => {
          if ((v as unknown as { offline?: boolean }).offline || !v.options) return;
          setView(v);
          setShownId(v.current_option_id || "safest");
          setScreen("trip");
        }).catch(() => rememberTrip(null));
      }
    }).catch(() => { if (!stop) { setError(t("line.noSignal")); window.setTimeout(boot, 3000); } });
    boot();
    return () => { stop = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- live updates: SSE, falling back to polling -----------------------------------------------
  useEffect(() => {
    if (!view?.id) return;
    const id = view.id;
    let poll: number | undefined;
    api.getPlan(id, lang).then(setView).catch(() => {});        // re-word immediately on language change
    const es = new EventSource(`/api/plan/${id}/stream?lang=${lang}`);
    es.addEventListener("plan_update", (e) => setView(JSON.parse((e as MessageEvent).data)));
    es.onerror = () => {
      es.close();
      if (!poll) poll = window.setInterval(() => api.getPlan(id, lang).then(setView).catch(() => {}), 4000);
    };
    return () => { es.close(); if (poll) window.clearInterval(poll); };
  }, [view?.id, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- live layer updates: SSE -------------------------------------------------------------
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/layers/stream");
      es.addEventListener("layer_update", () => {
        api.layers().then(setLayersMeta).catch(() => {});
        setLayerVersion((v) => v + 1);
      });
    } catch {}
    return () => {
      es?.close();
    };
  }, []);

  // ---- one banner at a time, each shown once ---------------------------------------------------
  useEffect(() => {
    const b = view?.banner;
    if (b && !seen.current.has(b.id)) {
      seen.current.add(b.id);
      setBannerId(b.id);
    }
  }, [view?.banner?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // text always comes from the latest view, so it follows a language switch
  const banner = view?.banner && view.banner.id === bannerId ? view.banner : null;

  const options = view?.options ?? [];
  const shown = options.find((o) => o.id === shownId) ?? options.find((o) => o.tab) ?? null;
  const current = options.find((o) => o.id === view?.current_option_id) ?? shown;

  // ---- actions ----------------------------------------------------------------------------------
  const find = useCallback(async (dest: Place | null = to) => {
    if (!from || !dest || !cfg) return;
    if (!isInsideCoverage(from.lat, from.lon, cfg) || !isInsideCoverage(dest.lat, dest.lon, cfg)) {
      setError(t("line.outsideArea"));
      setScreen("home");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const v = await api.plan(from, dest, when, by, lang);
      if (view?.id) api.drop(view.id);
      if (v.banner) seen.current.add(v.banner.id);
      if (!v.options.length) { setError(v.error_text || t("line.noWay")); setScreen("home"); return; }
      setView(v);
      setShownId("safest");
      setShowPlaces(false);
      setScreen("result");
    } catch {
      const last = lastTrip();                                    // no server: keep going on saved info
      if (last) {
        try { const v = await api.getPlan(last, lang); setView(v); setScreen("trip"); return; } catch { /* nothing saved */ }
      }
      setError(navigator.onLine ? t("line.noWay") : t("line.noSignal"));
      setScreen("home");
    } finally {
      setBusy(false);
    }
  }, [from, to, when, by, lang, view?.id, cfg, t]);

  const start = async () => {
    if (!view || !shown) return;
    setStarting(true);
    try {
      const v = await api.choose(view.id, shown.plan_id, lang);
      setView(v);
      setShownId(v.current_option_id || shown.id);
      rememberTrip(v.id);
    } catch { /* offline: carry on with what we have */ }
    setStarting(false);
    setScreen("trip");
  };

  const endTrip = () => {
    if (view?.id) api.drop(view.id);
    rememberTrip(null);
    setView(null);
    setRoutes([]);
    setSelectedRouteId(null);
    setShowCompare(false);
    setScreen("home");
  };

  const openNeed = async (type: string) => {
    if (!from) return;
    setLayerState((prev) => ({
      ...prev,
      facilities: {
        ...prev.facilities,
        [type]: true,
      },
    }));
    const n = NEEDS.find((x) => x.type === type)!;
    const base = { type, title: t(n.key as CopyKey), places: null, empty: null };
    setNeed(base);
    setScreen("opennow");
    try {
      const r = await api.needNow(type, from, lang);
      setNeed({ ...base, places: r.places, empty: r.empty_text });
    } catch {
      setNeed({ ...base, places: [], empty: t("line.noSignal") });
    }
  };

  const goTo = (p: PlaceOnWay) => {
    const dest: Place = { lat: p.lat, lon: p.lon, name: p.name, kind: null };
    setTo(dest);
    setHelpAt(null);
    find(dest);
  };

  const choosePlace = (p: Place, save: "home" | "work" | null) => {
    if (cfg && !isInsideCoverage(p.lat, p.lon, cfg)) {
      setError(t("line.outsideArea"));
      setScreen("home");
      return;
    }
    setError(null);
    if (save) {
      savePlace(save, p);
      (save === "home" ? setHome : setWork)({ ...p, kind: save });
    }
    if (field === "from") setFrom({ ...p, kind: null });
    else setTo({ ...p, kind: save });
    setScreen("home");
  };

  const quickPlace = (slot: Place | "home" | "work") => {
    if (typeof slot !== "string") {
      if (cfg && !isInsideCoverage(slot.lat, slot.lon, cfg)) {
        setError(t("line.outsideArea"));
        return;
      }
      setError(null);
      return setTo(slot);
    }
    const p = slot === "home" ? home : work;
    if (p) {
      if (cfg && !isInsideCoverage(p.lat, p.lon, cfg)) {
        setError(t("line.outsideArea"));
        return;
      }
      setError(null);
      setTo({ ...p, kind: slot });
    } else {
      setField("to");
      setScreen("search");
    }
  };

  const onBackup = (id: string) => {
    setShownId(id);
    setScreen("result");
  };

  // ---- map for each screen ---------------------------------------------------------------------
  const mapView = useMemo(() => {
    if ((screen === "result") && shown) {
      return { path: shown.path, start: shown.start, end: shown.end, places: showPlaces ? shown.places : [],
               fitKey: `r-${view?.id}-${shown.id}-${showPlaces}` };
    }
    if (screen === "trip" && current) {
      return { path: current.path, start: current.start, end: current.end, me: view?.trip?.position ?? null,
               fitKey: `t-${view?.id}-${current.plan_id}` };
    }
    if (screen === "opennow") {
      return { places: need?.places ?? [], start: ll(from), fitKey: `n-${need?.type}-${need?.places?.length}` };
    }
    return { start: ll(from), end: ll(to), fitKey: `h-${from?.lat}-${to?.lat}` };
  }, [screen, shown, current, showPlaces, view?.id, view?.trip?.position, need, from, to]);

  if (!cfg) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <span className="text-[2.5rem]" aria-hidden="true">🌙</span>
        <p className="text-[1.2rem] font-semibold">{error || t("line.finding")}</p>
      </div>
    );
  }

  const demo = { showDemo: SHOW_DEMO, onDemo: () => setDemoOpen(true) };
  return (
    <div className="relative h-full overflow-hidden">
      <MapCanvas
        center={cfg.center}
        boundary={cfg.polygon}
        bbox={cfg.bbox}
        showCoverage={showCoverage}
        showDataCoverage={showDataCoverage}
        layerState={layerState}
        from={from}
        onTakeMeThere={(dest) => {
          const target: Place = { lat: dest.lat, lon: dest.lon, name: dest.name, kind: null };
          setTo(target);
          find(target);
        }}
        onFacilityCounts={setFacilityCounts}
        bottomPad={sheetH}
        offline={conn === "offline"}
        layerVersion={layerVersion}
        routes={screen === "result" ? routes : undefined}
        selectedRouteId={selectedRouteId ?? undefined}
        onSelectRoute={(id) => {
          setSelectedRouteId(id);
          const opt = options.find((o) => o.id === id);
          if (opt) setShownId(opt.id);
        }}
        showDominated={showDominatedRoutes}
        {...mapView}
        onPick={screen === "pick" ? async (lat, lon) => {
          if (cfg && !isInsideCoverage(lat, lon, cfg)) {
            setError(t("line.outsideArea"));
            return;
          }
          setError(null);
          const name = await api.where(lat, lon, lang).then((r) => r.name).catch(() => t("label.pickedPoint"));
          choosePlace({ lat, lon, name }, field === "to" ? pickSave : null);
        } : null}
      />

      <LayerPanel
        layersMeta={layersMeta}
        state={layerState}
        onChange={setLayerState}
        counts={facilityCounts}
        simHour={2}
        originLat={from?.lat ?? cfg.center.lat}
        originLon={from?.lon ?? cfg.center.lon}
        onRefreshMeta={() => {
          api.layers().then(setLayersMeta).catch(() => {});
          setLayerVersion((v) => v + 1);
        }}
      />

      {/* Coverage legend toggle & Area label pill */}
      <div className="fixed left-3 top-3 z-30 flex flex-col items-start gap-1.5 pointer-events-auto">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              const next = !showCoverage;
              setShowCoverage(next);
              setLayerState((s) => ({ ...s, showCoverage: next }));
            }}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-[0.82rem] font-semibold shadow-md backdrop-blur-md transition-colors ${
              showCoverage
                ? "border-accent/60 bg-surface/90 text-accent"
                : "border-edge bg-surface/75 text-soft hover:text-ink"
            }`}
            aria-pressed={showCoverage}
            title={t("label.showCoverage")}
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: showCoverage ? "#8b7cff" : "#64748b" }}
              aria-hidden="true"
            />
            {t("label.showCoverage")}
          </button>
          <button
            onClick={() => setShowDataCoverage((v) => !v)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.82rem] font-semibold shadow-md backdrop-blur-md transition-colors ${
              showDataCoverage
                ? "border-good/60 bg-surface/90 text-good"
                : "border-edge bg-surface/75 text-soft hover:text-ink"
            }`}
            aria-pressed={showDataCoverage}
            title="Data coverage"
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: showDataCoverage ? "#34d399" : "#64748b" }}
              aria-hidden="true"
            />
            Data
          </button>
        </div>
        {showCoverage && (
          <div className="rounded-full border border-edge bg-surface/90 px-3 py-0.5 text-[0.76rem] font-medium text-ink shadow backdrop-blur-md">
            {t("fmt.coverageArea", {
              area: String(cfg.area_km2 || diagnostics?.area_km2 || 49),
              streets: String(diagnostics?.walk_edges || cfg.vertex_count || 8020),
            })}
          </div>
        )}
      </div>

      <Pill connection={conn} />
      {banner && <Banner id={banner.id} text={banner.text} onDone={() => setBannerId(null)}
        onSee={() => { if (banner.see_option_id) setShownId(banner.see_option_id); }} />}

      {screen === "home" && (
        <Home from={from} to={to} home={home} work={work} when={when} by={by} busy={busy} error={error}
          onFrom={() => { setError(null); setField("from"); setScreen("search"); }}
          onTo={() => { setError(null); setField("to"); setScreen("search"); }}
          onPlace={quickPlace} onWhen={setWhen} onBy={setBy} onFind={() => find()} onNeed={openNeed} onHeight={setSheetH} {...demo} />
      )}
      {screen === "search" && (
        <Search field={field} onBack={() => { setError(null); setScreen("home"); }} onChoose={choosePlace} onHeight={setSheetH}
          onPickMap={(save) => { setError(null); setPickSave(save); setScreen("pick"); }} />
      )}
      {screen === "pick" && (
        <div className="fixed inset-x-0 bottom-6 z-20 flex flex-col items-center gap-2 px-3">
          {error && (
            <div className="rounded-2xl bg-warn px-4 py-2.5 text-[1rem] font-bold text-night shadow-xl" role="alert">
              {error}
            </div>
          )}
          <div className="flex w-full max-w-[480px] items-center gap-2 rounded-3xl bg-surface px-3 py-3 shadow-xl">
            <BackButton onClick={() => { setError(null); setScreen("search"); }} />
            <p className="text-[1.15rem] font-semibold">{t("line.tapMap")}</p>
          </div>
        </div>
      )}
      {screen === "result" && shown && (
        <Result
          options={options}
          shown={shown}
          onTab={(id) => {
            setShownId(id);
            setSelectedRouteId(id);
          }}
          onBackup={onBackup}
          onStart={start}
          starting={starting}
          onBack={() => setScreen("home")}
          showPlaces={showPlaces}
          setShowPlaces={setShowPlaces}
          onHeight={setSheetH}
          onCompare={() => setShowCompare(true)}
          {...demo}
        />
      )}
      {showCompare && view && routes.length > 0 && (
        <CompareRoutesSheet
          routes={routes}
          selectedId={selectedRouteId}
          onSelect={(id: string) => {
            setSelectedRouteId(id);
            const opt = options.find((o) => o.id === id);
            if (opt) setShownId(opt.id);
          }}
          onClose={() => setShowCompare(false)}
          showDominated={showDominatedRoutes}
          onToggleDominated={setShowDominatedRoutes}
        />
      )}
      {screen === "trip" && current && (
        <Trip option={current} trip={view?.trip ?? null} onEnd={endTrip} onBackup={onBackup} onHeight={setSheetH} {...demo}
          onHelp={() => setHelpAt(view?.trip?.position ? { lat: view.trip.position[0], lon: view.trip.position[1], name: "" } : from)} />
      )}
      {screen === "opennow" && need && (
        <OpenNow title={need.title} currentType={need.type} places={need.places} empty={need.empty} onBack={() => setScreen("home")}
          onPick={goTo} onSwitchNeed={openNeed} onHeight={setSheetH} />
      )}
      {helpAt && <HelpSheet at={helpAt} planId={view?.id ?? null} onClose={() => setHelpAt(null)} onGo={goTo} />}

      <Suspense fallback={null}>
        {demoOpen && <DemoDrawer view={view} onClose={() => setDemoOpen(false)} />}
      </Suspense>
    </div>
  );
}

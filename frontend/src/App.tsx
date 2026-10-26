import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONFIG } from "./config";
import { useT, type CopyKey } from "./copy";
import type { TripAsk } from "./engine/worker";
import { MapCanvas } from "./components/MapCanvas";
import { SosButton } from "./components/SosButton";
import { BackButton, Banner, DeviationBanner, Pill } from "./components/ui";
import { setDemoActive } from "./lib/demoFlag";
import { DeviationMonitor } from "./engine/deviation";
import { fakeGps, useFakeGps, usePosition } from "./lib/position";
import { call, listen } from "./lib/engine";
import { useLive } from "./lib/live";
import { freshFix, lastTrip, loadFlag, loadLastFix, loadPlace, myLocation, rememberTrip, saveFlag, saveLastFix, savePlace } from "./lib/saved";
import { alertContact, mapLink, restoreRealBluetooth, smsHref } from "./sos";
import { armTimer, disarmTimer, loadTimer, onTimerTapped, saveTimer, timerTimes } from "./sos/safetyTimer";
import { Home, NEEDS } from "./screens/Home";
import { OpenNow } from "./screens/OpenNow";
import { Result } from "./screens/Result";
import { Search } from "./screens/Search";
import { HelpSheet, SafetySheet } from "./screens/Help";
import { Trip } from "./screens/Trip";
import type { AppConfig, LatLon, Place, PlaceOnWay, SimpleView } from "./types";

// Judges only: code-split, never in the first download (spec §11).
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

function Main() {
  const { t, lang } = useT();
  const [cfg, setCfg] = useState<AppConfig | null>(null);
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
  const [help, setHelp] = useState<{ at: Place | null; fresh: boolean } | null>(null);
  const lastFix = useRef<Place | null>(null);
  useEffect(() => { loadLastFix().then((p) => { if (p && !lastFix.current) lastFix.current = { ...p, name: "" }; }); }, []);
  const [sheetH, setSheetH] = useState(380);
  const [bannerId, setBannerId] = useState<string | null>(null);
  const [demoOpen, setDemoOpen] = useState(false);
  const [lateAlert, setLateAlertState] = useState(false);
  const [safety, setSafety] = useState<"ask" | "late" | null>(null);
  const [dev, setDev] = useState<"ok" | "off" | "far">("ok");
  const [askOk, setAskOk] = useState(false);
  const [note, setNote] = useState<{ id: string; text: string } | null>(null);   // the app's own one-line banner
  const [appNow, setAppNow] = useState(Date.now());
  const devMon = useRef(new DeviationMonitor());
  const fixRef = useRef<{ lat: number; lon: number } | null>(null);
  const fakeOn = useFakeGps();
  useEffect(() => { setDemoActive(fakeOn || Math.abs(appNow - Date.now()) > 120000); }, [fakeOn, appNow]);
  const seen = useRef(new Set<string>());
  const ask = useRef<TripAsk | null>(null);
  const conn = useLive(cfg?.center ?? null);

  // ---- boot: the engine loads the bundled city; a trip this phone already started carries on ----------
  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const c = await call("init");
        if (stop) return;
        setCfg(c);
        setHome(await loadPlace("home", c.ui_defaults));
        setWork(await loadPlace("work", c.ui_defaults));
        setBy(c.ui_defaults.deadline);
        setFrom(await myLocation(c.ui_defaults));
        setLateAlertState(await loadFlag("lateAlert"));
        restoreRealBluetooth({ title: t("label.appName"), text: t("line.meshOn") }).catch(() => {});
        const saved = await lastTrip();
        if (!saved || stop) return;
        let v = await call("plan", saved.ask);
        if (!v?.options.length) { rememberTrip(null); return; }
        ask.current = saved.ask;
        const opt = v.options.find((o) => o.id === saved.option);
        if (saved.started && opt) v = (await call("choose", opt.plan_id)) ?? v;
        if (v.banner) seen.current.add(v.banner.id);
        setFrom({ ...saved.ask.from, kind: saved.ask.from.kind ?? null });
        setTo({ ...saved.ask.to, kind: saved.ask.to.kind ?? null });
        setWhen(saved.ask.when);
        setBy(saved.ask.by);
        setView(v);
        setShownId(v.current_option_id || saved.option);
        setScreen(saved.started ? "trip" : "result");
      } catch {
        if (!stop) setError(t("line.noWay"));
      }
    })();
    return () => { stop = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- live updates: the engine pushes a fresh view on every tick; words follow the language ----------
  useEffect(() => listen((m) => { if (m.type === "view") setView(m.view); else setAppNow(m.now); }), []);
  useEffect(() => { call("setLang", lang).catch(() => {}); }, [lang]);

  // ---- safety timer: ask "Are you home?", then alert the contact if there is no answer ----------------
  const here = (): Place | null => (fixRef.current ? { lat: fixRef.current.lat, lon: fixRef.current.lon, name: "" }
    : view?.trip?.position ? { lat: view.trip.position[0], lon: view.trip.position[1], name: "" } : from);
  const hereRef = useRef(here);
  hereRef.current = here;
  useEffect(() => {
    const check = async () => {
      const tm = await loadTimer();
      if (!tm || tm.answered) return;
      const now = Date.now();
      if (now >= tm.alertAt && !tm.alerted) {
        const at = hereRef.current() ?? { lat: tm.lat, lon: tm.lon };
        await saveTimer({ ...tm, alerted: true });
        alertContact(at).catch(() => {});
        setSafety("late");
      } else if (now >= tm.askAt) {
        setSafety((s) => s ?? (tm.alerted ? "late" : "ask"));
      }
    };
    check();
    const id = window.setInterval(check, CONFIG.safetyTimer.checkMs);
    const off = onTimerTapped(() => { check(); });
    return () => { window.clearInterval(id); off(); };
  }, []);
  const setLateAlert = (on: boolean) => { setLateAlertState(on); saveFlag("lateAlert", on); };
  const imHome = () => { disarmTimer(); setSafety(null); };
  const safetyHelp = async () => {
    const tm = await loadTimer();
    if (tm) await saveTimer({ ...tm, answered: true });
    setSafety(null);
    openHelp();
  };

  /** SOS: open Help at once with the place we have, then try for a fresh GPS fix. A fix outside the
   *  area means demo mode (the app's place is simulated), so the app's place is kept. */
  const openHelp = () => {
    setHelp({ at: here() ?? lastFix.current, fresh: false });
    freshFix().then(async (p) => {
      if (!p) return;
      saveLastFix(p);
      lastFix.current = { ...p, name: "" };
      const inside = await call("inArea", p.lat, p.lon).catch(() => false);
      if (inside || !here()) setHelp((h) => (h ? { at: { ...p, name: "" }, fresh: true } : h));
    });
  };

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

  // ---- deviation warning (UPGRADE §7): real GPS when the trip started from a real fix, else the Demo's fake GPS ----
  const onTrip = screen === "trip" && !!current && !view?.trip?.arrived;
  const realStart = !!from && from.kind === "here" && !from.demo;
  const fix = usePosition(onTrip, realStart);
  fixRef.current = fix;
  useEffect(() => {
    if (!fix || !onTrip || !current || !cfg) return;
    const vehicle = view?.trip?.next_icon === "bus" || view?.trip?.next_icon === "metro";
    const hour = new Date(appNow + (cfg.tz_offset_min ?? 330) * 60000).getUTCHours();
    const [a, b] = cfg.night_hours ?? [19, 6];
    const st = devMon.current.update(fix, current.path, vehicle, hour >= a || hour < b);
    setDev(devMon.current.shown(Date.now()));
    if (st.still) setAskOk(true);
  }, [fix]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!onTrip) { devMon.current.reset(); setDev("ok"); } }, [onTrip]);

  /** "New way": plan again from where the phone is now, same destination and "Be there by". */
  const newWayFromHere = async () => {
    const at = fix ?? (view?.trip?.position ? { lat: view.trip.position[0], lon: view.trip.position[1] } : null);
    if (!at || !ask.current) return;
    const a: TripAsk = { ...ask.current, from: { lat: at.lat, lon: at.lon, name: "", kind: null }, when: null };
    const v = await call("plan", a).catch(() => null);
    if (!v?.options.length) return;
    const opt = v.options.find((o) => o.id === shownId) ?? v.options.find((o) => o.tab) ?? v.options[0];
    const v2 = (await call("choose", opt.plan_id).catch(() => null)) ?? v;
    ask.current = a;
    rememberTrip({ ask: a, option: opt.id, started: true });
    setView(v2);
    setShownId(v2.current_option_id || opt.id);
    devMon.current.reset();
    setDev("ok");
    const now = v2.options.find((o) => o.id === (v2.current_option_id || opt.id));
    if (now && fakeGps.running()) fakeGps.follow(now.path);
    setNote({ id: `nw-${Date.now()}`, text: t("line.newWayFromHere") });
  };


  // ---- actions ----------------------------------------------------------------------------------
  const find = useCallback(async (dest: Place | null = to) => {
    if (!from || !dest) return;
    setBusy(true);
    setError(null);
    try {
      const a: TripAsk = { from, to: dest, when, by };
      const v = await call("plan", a);
      if (!v || !v.options.length) { setError(v?.error_text || t("line.noWay")); setScreen("home"); return; }
      if (v.banner) seen.current.add(v.banner.id);
      ask.current = a;
      rememberTrip({ ask: a, option: "safest", started: false });
      setView(v);
      setShownId("safest");
      setShowPlaces(false);
      setScreen("result");
    } catch {
      setError(t("line.noWay"));
      setScreen("home");
    } finally {
      setBusy(false);
    }
  }, [from, to, when, by, t]);

  const start = async () => {
    if (!view || !shown) return;
    setStarting(true);
    try {
      const v = await call("choose", shown.plan_id);
      if (v) { setView(v); setShownId(v.current_option_id || shown.id); }
      if (ask.current) rememberTrip({ ask: ask.current, option: v?.current_option_id || shown.id, started: true });
      if (lateAlert && from) {
        const tm = await call("timing");
        if (tm.deadline) await armTimer({ ...timerTimes(tm.deadline, tm.now, tm.speed), lat: from.lat, lon: from.lon }, { title: t("line.areYouHome"), body: t("line.tapToAnswer") });
      }
    } catch { /* carry on with what we have */ }
    setStarting(false);
    setScreen("trip");
  };

  const endTrip = () => {
    call("endTrip").catch(() => {});
    disarmTimer();
    setSafety(null);
    rememberTrip(null);
    ask.current = null;
    setView(null);
    setScreen("home");
  };

  const openNeed = async (type: string) => {
    if (!from) return;
    const n = NEEDS.find((x) => x.type === type);
    const base = { type, title: n ? t(n.key as CopyKey) : t("label.safePlaces"), places: null, empty: null };
    setNeed(base);
    setScreen("opennow");
    try {
      const places = await call("needNow", type, from.lat, from.lon);
      setNeed({ ...base, places, empty: places.length ? null : t("line.nothingOpen") });
    } catch {
      setNeed({ ...base, places: [], empty: t("line.nothingOpen") });
    }
  };

  const goTo = (p: PlaceOnWay) => {
    const dest: Place = { lat: p.lat, lon: p.lon, name: p.name, kind: null };
    setTo(dest);
    setHelp(null);
    find(dest);
  };

  const choosePlace = (p: Place, save: "home" | "work" | null) => {
    if (save) {
      savePlace(save, p);
      (save === "home" ? setHome : setWork)({ ...p, kind: save });
    }
    if (field === "from") setFrom({ ...p, kind: null });
    else setTo({ ...p, kind: save });
    setScreen("home");
  };

  const quickPlace = (slot: Place | "home" | "work") => {
    if (typeof slot !== "string") return setTo(slot);
    const p = slot === "home" ? home : work;
    if (p) setTo({ ...p, kind: slot });
    else { setField("to"); setScreen("search"); }
  };

  const onBackup = (id: string) => {
    if (id === "safe") { openNeed("safe"); return; }
    setShownId(id);
    setScreen("result");
  };

  // ---- map for each screen ---------------------------------------------------------------------
  const mapView = useMemo(() => {
    if ((screen === "result") && shown) {
      return { path: shown.path, start: shown.start, end: shown.end, changes: shown.changes, places: showPlaces ? shown.places : [],
               fitKey: `r-${view?.id}-${shown.id}-${showPlaces}` };
    }
    if (screen === "trip" && current) {
      return { path: current.path, start: current.start, end: current.end, changes: current.changes, me: fix ? [fix.lat, fix.lon] as LatLon : view?.trip?.position ?? null,
               fitKey: `t-${view?.id}-${current.plan_id}` };
    }
    if (screen === "opennow") {
      return { places: need?.places ?? [], start: ll(from), fitKey: `n-${need?.type}-${need?.places?.length}` };
    }
    return { start: ll(from), end: ll(to), fitKey: `h-${from?.lat}-${to?.lat}` };
  }, [screen, shown, current, showPlaces, view?.id, view?.trip?.position, need, from, to]);

  if (!cfg) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="status">
        <span className="text-[2.5rem]" aria-hidden="true">🌙</span>
        <p className="text-[1.2rem] font-semibold">{error || t("line.finding")}</p>
        <SosButton onPress={openHelp} />
        {help && <HelpSheet at={help.at} fresh={help.fresh} onClose={() => setHelp(null)} onGo={() => setHelp(null)} />}
      </div>
    );
  }

  const demo = { showDemo: SHOW_DEMO, onDemo: () => setDemoOpen(true) };
  return (
    <div className="relative h-full overflow-hidden">
      <MapCanvas center={cfg.center} bbox={cfg.bbox} bottomPad={sheetH} topPad={screen === "trip" ? 150 : 80} {...mapView}
        onPick={screen === "pick" ? async (lat, lon) => {
          const name = (await call("where", lat, lon).catch(() => null)) || t("label.pickedPoint");
          choosePlace({ lat, lon, name }, field === "to" ? pickSave : null);
        } : null} />
      <Pill connection={conn} long={screen === "trip"} />
      {onTrip && dev !== "ok" && !help && (
        <DeviationBanner level={dev} onNewWay={newWayFromHere} onSos={openHelp}
          onFine={() => { devMon.current.snooze(Date.now()); setDev("ok"); }}
          sms={smsHref(t("fmt.smsOffWay", { link: fix ? mapLink(fix.lat, fix.lon) : "" }))} />
      )}
      {note && dev === "ok" && <Banner id={note.id} text={note.text} onDone={() => setNote(null)} />}
      {banner && !note && dev === "ok" && <Banner id={banner.id} text={banner.text} onDone={() => setBannerId(null)}
        onSee={() => { if (banner.see_option_id) setShownId(banner.see_option_id); }} />}

      {screen === "home" && (
        <Home from={from} to={to} home={home} work={work} when={when} by={by} busy={busy} error={error}
          onFrom={() => { setField("from"); setScreen("search"); }} onTo={() => { setField("to"); setScreen("search"); }}
          onPlace={quickPlace} onWhen={setWhen} onBy={setBy} onFind={() => find()} onNeed={openNeed} onHeight={setSheetH} {...demo} />
      )}
      {screen === "search" && (
        <Search field={field} onBack={() => setScreen("home")} onChoose={choosePlace} onHeight={setSheetH}
          onPickMap={(save) => { setPickSave(save); setScreen("pick"); }} />
      )}
      {screen === "pick" && (
        <div className="fixed inset-x-0 bottom-6 z-20 flex justify-center px-3">
          <div className="flex w-full max-w-[480px] items-center gap-2 rounded-3xl bg-surface px-3 py-3 shadow-xl">
            <BackButton onClick={() => setScreen("search")} />
            <p className="text-[1.15rem] font-semibold">{t("line.tapMap")}</p>
          </div>
        </div>
      )}
      {screen === "result" && shown && (
        <Result options={options} shown={shown} onTab={setShownId} onBackup={onBackup} onStart={start} starting={starting} lateAlert={lateAlert} setLateAlert={setLateAlert}
          onBack={() => setScreen("home")} showPlaces={showPlaces} setShowPlaces={setShowPlaces} onHeight={setSheetH} {...demo} />
      )}
      {screen === "trip" && current && (
        <Trip option={current} trip={view?.trip ?? null} onEnd={endTrip} onBackup={onBackup} onHeight={setSheetH} {...demo}
          onHelp={openHelp} />
      )}
      {screen === "opennow" && need && (
        <OpenNow title={need.title} places={need.places} empty={need.empty} onBack={() => setScreen("home")}
          onPick={goTo} onHeight={setSheetH} />
      )}
      {help && <HelpSheet at={help.at} fresh={help.fresh} onClose={() => setHelp(null)} onGo={goTo} />}
      {safety && !help && from && <SafetySheet at={here() ?? from} late={safety === "late"} onHome={imHome} onHelp={safetyHelp} />}
      {askOk && !safety && !help && from && <SafetySheet ok at={here() ?? from} late={false}
        onHome={() => { devMon.current.okStill(Date.now()); setAskOk(false); }} onHelp={() => { setAskOk(false); openHelp(); }} />}
      <SosButton onPress={openHelp} />

      <Suspense fallback={null}>
        {demoOpen && <DemoDrawer view={view} onClose={() => setDemoOpen(false)} />}
      </Suspense>
    </div>
  );
}

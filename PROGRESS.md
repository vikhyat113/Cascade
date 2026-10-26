# Progress

## Phase 0: environment + audit (done)
- JDK 17, Android SDK (platform 34, build-tools 34, adb) installed per-user; see ENVIRONMENT.md.
- Repo audited; plan in AUDIT.md. New SPEC.md in place; older specs in legacy/specs/.
- Phone (POCO X6 Pro) only offers file transfer, so `adb` sees nothing. Install path is MTP copy + tap-to-install (`scripts/push-apk.ps1`).

## Phase 1: Capacitor shell (done, tag phase-1)
- Capacitor 6.2.1 in `frontend/` (Cap 7 needs JDK 21). `scripts/build-apk.sh` builds the debug APK; it installs and opens on the phone.

## Phase 2: engine on the phone (done, tag phase-2)
- `tools/build_data.py` → `frontend/src/data/*.json` (graph, POIs, places, weather snapshot, synthetic incidents + timetable, meta with real/synthetic lists).
- TypeScript engine in `frontend/src/engine/`: freshness, clock + city time, world/routing, feeds simulator, events, risk, transit, planner, re-planner with hysteresis, need-now, validator, simple view, scenario harness.
- Vitest: 47 tests, ~12 s (freshness/hours, planner on the real bundle, simple-view mapping + plain-words check, 8 scenarios, copy deck rules). `npm run build` runs them first.

## Phase 3: screens on the in-app engine (done, tag phase-3)
- Engine runs in a Web Worker; Home → Result → Trip → Open now all use it (no server). Old HTTP client moved to `legacy/frontend-web/`.
- Map draws the bundled roads (no tiles). Pill: Live / Offline (real Open-Meteo probe); trip screen says "Offline: using saved info".
- Home / Work, language and the last trip saved with Capacitor Preferences; a started trip resumes after a restart. GPS via Capacitor Geolocation (location permission added to the manifest).
- Colours come only from `theme.ts` (CSS variables). `scripts/build-apk.sh` fixed for Git Bash on Windows (`sh ./gradlew`, finds the per-user JDK/SDK).
- Verified in headless Chrome at 360x740: boot to Home 0.4 s, plan 0.3 s, reload resumes the trip, offline line shows, Open now lists places, no console errors.
- Checked on the phone (POCO X6 Pro) by the user: installs, opens, plans.

## Phase 4: Help, dispatch, mesh, safety timer (done, tag phase-4)
- Help: **Call 112**, three big buttons (I'm in danger / I need a doctor / Not sure), **Text my contact** (SMS with map link). Status: Sending… → Passed on → Help is aware, or Not sure.
- Ladder (`src/sos/ladder.ts`): direct to the dispatch server if reachable, else simulated mesh; next desk after 20 s without acknowledgement.
- `server/`: Node + Express dispatch server, port 8787, dashboard with Police / Hospital / Contact tabs, live list, Acknowledge. **Simulated** (stated in its page, README and Demo drawer).
- `SimulatedMeshTransport`: 6 virtual phones, gossip, dedupe, hop limit, store-and-forward gateway, acks back. Demo drawer: animated graph, "Help via mesh", gateway signal, dispatch URL + test, "Safety timer: ask now".
- Safety timer with local notification (`@capacitor/local-notifications`).
- Tests: 55 in total (8 new: ladder, mesh, timer times). Browser run at 360 px: direct help → ack → "Help is aware"; mesh help (3 hops) → ack; timer → Contact desk alert + SMS offered; no console errors.
- **Unverified on the phone**: notification permission prompt, SMS/tel intents, reaching the laptop over Wi-Fi (Windows firewall must allow Node).

## Phase 5: Demo drawer and scenarios (done, tag phase-5)
- Drawer in spec order: 1 Break things · 2 Make it happen · 3 Time (**Set to 2:15 AM**, 1x/10x/60x, pause, +5 min, back to real time) · 4 Scenarios (run all, table) · 5 Data check (official statuses, age, real/simulated) · 6 Change log · 7 Mesh · 8 Dispatch server URL · 9 Real Bluetooth (off).
- Fixed: toggles were usable before their state loaded (a tap could flip the wrong way); quick "+5 min" taps raced and reset the night.
- Browser run at 360 px (quality gates): 2:15 AM in daytime → fresh plan "On time"; Road closed → one plain banner; All live info off + 15 min → plan kept, pill "Offline: using saved info", "Traffic info is old." + Backup, no banned words; scenarios 8/8 in ~10 s; no console errors.

## Phase 6: polish and release (done, tag phase-6, feature freeze)
- About screen with OpenStreetMap / Open-Meteo credits; remaining English accessibility labels moved into the copy deck (Hindi too).
- Audit at 360 px, English and Hindi, normal and 130 % font, on Home / About / Result / Trip / Help: no sideways scrolling, nothing cut off, every control named, every tap target ≥ 44 px, no banned words, no page errors.
- Fixed: "Old info" pill wrapping; a warning + Backup still shown after "You have arrived."
- README.md and DEMO.md rewritten for the Android app (old ones in `legacy/`). Screenshots in `docs/screenshots/app/`.
- Final APK: `frontend/android/app/build/outputs/apk/debug/app-debug.apk` (7 MB), built with the dispatch URL `http://192.168.105.248:8787` (this laptop's Wi-Fi address today; change it in Demo → 8 if it moves). Copied to the phone's Download folder.
- **Unverified on the phone**: notification prompt, SMS/tel intents, phone → laptop over Wi-Fi.
- Known gaps: the result screen shows about 35 words with the late-alert switch on (spec: about 25); scenario results show "age 0 s" for data newer than a clock set back in the Demo drawer.

## Phase 7: real Bluetooth relay (built, two-phone test pending)
- Native Capacitor plugin in Kotlin (`frontend/android/app/src/main/java/org/cascade/nightway/mesh/`), `BleMeshTransport` in `src/sos/ble.ts`, Demo drawer 9. Flag `MESH_REAL` off by default; any failure falls back to the simulated mesh.
- Builds and all 56 tests pass. **Not yet verified between two phones**: steps in docs/BLE_STATUS.md; results to be recorded there.

## UPGRADE (branch nightway-nagpur, see UPGRADE.md / UPGRADE_AUDIT.md)

### U1: Nagpur and Butibori (done, tag up-1)
- Area = 3 named zones in `data/area.geojson` (`scripts/area.py`): Nagpur core (4 km around Sitabuldi), Butibori + IIIT Nagpur (3.2 km), Wardha Road corridor (500 m along 25.3 km of NH-44, found by routing on OSM main roads).
- Places geocoded once with Nominatim (`scripts/geocode_places.py`, cached). IIIT Nagpur's permanent campus is not named in OSM: Waranga village stands in (**to confirm**).
- Rebuilt: walk graph (full detail in zones, major roads in the corridor; 13,872 segments: 933 km Nagpur, 142 km Butibori, 67 km corridor), drive graph (derived from it), POIs (272 hospitals, 26 metro stations, only 10 bus stops in OSM), weather (Nagpur), synthetic incidents. Bundle 2.5 MB.
- App: "in the area" = inside / within 300 m of a zone; GPS outside → demo start (IIIT Nagpur); map pans within the zones + 3 km; Demo 5 location check names the zone.
- Bus tests and scenarios 2/5 run along whatever bus route exists (`bus:start` / `bus:end`), so they test timetable logic, not one city's routes.
- Checks: 56 app tests + 53 Python backend tests pass; browser run on the new city works (plan 0.9 s for IIIT → Dharampeth).
- Unverified: planning time on the phone for the 25 km trip; Waranga as IIIT stand-in.

### U5: SOS on every screen (done, tag up-5)
- Red **SOS** button (56 px, top-right, above every sheet, banner, dialog and the Demo drawer) on every screen, including the loading screen. One tap opens Help at once; Call 112 is the first control; the danger / doctor / not sure choice inside the sheet is the only guard.
- Place for help: a fresh GPS fix (5 s), else the last known place ("Using last place."), else "No place yet. Call 112." (the SMS then has no map link). A fix outside the zones keeps the app's (demo) place.
- Status pill moved left, map credit under it, trip card and banners below the top row. No flag can hide SOS.
- Tests: SOS unit test (label + screen-reader name in EN/HI, size, layer) and `npm run e2e` (Chrome, 360 px, EN + HI: first screen, home, about, demo drawer, search, open now, result, trip, help: visible, 56 px, not covered; Call 112 first). All pass.

### U4: no cab; Metro + estimated buses; transfers (done, tag up-4)
- Transit data search (docs/TRANSIT_DATA.md): OSM has **0 bus routes**, real **Metro** (Orange, Aqua: 06:00-22:00, every 15 min); no GTFS exists. Buses: estimated routes **E1-E4** (Butibori - Wardha Road - Sitabuldi; IIIT (Waranga) - Butibori; Railway Station - Sitabuldi - Dharampeth; Sadar - Sitabuldi - Ajni), hours **unknown**. Template `data/manual_bus_routes.csv` for real routes.
- Cab removed everywhere in the app (old code in `legacy/frontend-app-cab/`).
- Transfers: up to 2 changes ("Change here. Wait about 16 min."), change stops on the map, at most 4 steps + "More steps".
- Unknown hours: "Not sure buses run now." + Backup (another way, or Safe places); never preferred over a way expected to work. Demo: "Pretend night buses run (simulated)".
- Fixed while testing: brute-force nearest-place search (689 ms → 84 ms per slice); 27 km walk offered as Backup; the simulated bus feed ignored the pretend switch.
- Checks: 64 app tests (new: no invented night service, transfers IIIT → Dharampeth < 1.5 s, change wording, unknown-hours warning, grid search = brute force) + 53 backend tests; browser run of IIIT → Home at 2:15 AM with and without pretending.
- Unverified on the phone: planning time for the long trip.

### U6: deviation warning (done, tag up-6)
- `engine/deviation.ts`: distance + progress to the planned way, accuracy filter, hysteresis, off / far levels, snooze, "Are you OK?" when still at night. Banners: "You are off the way." (New way / I'm fine), "You are far from the way." (New way / Call someone / SOS). "New way" re-plans from the current fix.
- Demo drawer 10: fake GPS "Walk the way" 1× / 10×, "Wander off" 80 / 300 m, "Demo time" chip.
- Fixed while testing: Wander off kept walking alongside a winding way and kept coming back within 60 m (now a jump to a fixed spot); "far" was hidden by the 3-min snooze (now always shown).
- Checks: 9 deviation tests (maths, jitter quiet, hysteresis, accuracy, far by distance / time, vehicle line, snooze, far during snooze, still) + re-plan from an off point; browser run: off after 24 s, I'm fine, far, New way; SOS e2e still passes.
- Unverified on the phone: real GPS watch accuracy and battery during a trip.

### U2: map layers (done, tag up-2)
- Layers button + sheet: Streets lit, Safety heat (hour slider), Help places (open now / include not sure), Weather, Night lights; More: strength, moon light (computed), details in plain words. Lazy layer files.
- Night lights from NASA satellite (public GIBS, median of 8 nights) + lighting prior for unmarked streets (PROBABLE only; lowers UNKNOWN share). Weather grid (Open-Meteo, 13 points). Thermal cut (documented).
- Checks: 79 app tests (satellite prior: lowers UNKNOWN, never KNOWN, never overrides tags; moon new/full and up/down; heat cells and hours); browser run: all five layers on, lazy files fetched only on switch-on, no errors; SOS e2e passes.

### U3: other ways (done, tag up-3)
- Port of routing.py (Yen + comparison) with golden tests against the verbatim Python; one Python parsing bug found and documented.
- Diverse walking ways (Yen + penalty top-up), cached per risk slice; "Other ways" sheet with colours on the map, best pick, plain reasons, close-choice note.
- Fixed while testing: sheet size watcher read a removed sheet (page error); bus ways said "Could make you late" when the truth is unknown hours.
- Checks: 92 app tests (11 golden); browser: Other ways sheet with 4 ways, pick one, no errors; SOS e2e passes.

## Commands
- Tests: `cd frontend && npm test` · SOS on every screen: `npm run build && npm run e2e` · Dev in Chrome: `npm run dev` · APK: `bash scripts/build-apk.sh` then `powershell -ExecutionPolicy Bypass -File scripts\push-apk.ps1`, install from Files → Downloads on the phone.

## Commands (dispatch)
- `cd server && npm install && npm start`, then put the printed Wi-Fi address in Demo → 8. Dispatch server.

## Next
- Two-phone Bluetooth test (user), then record results in docs/BLE_STATUS.md.

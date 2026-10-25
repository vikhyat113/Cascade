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

## Commands
- Tests: `cd frontend && npm test` · Dev in Chrome: `npm run dev` · APK: `bash scripts/build-apk.sh` then `powershell -ExecutionPolicy Bypass -File scripts\push-apk.ps1`, install from Files → Downloads on the phone.

## Commands (dispatch)
- `cd server && npm install && npm start`, then put the printed Wi-Fi address in Demo → 8. Dispatch server.

## Next
- Phase 6: polish, 360px / large font / Hindi checks, accessibility labels, README, DEMO.md, final APK.

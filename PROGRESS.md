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
- **Unverified on the real phone yet**: worker + location prompt inside the Android WebView (APK copied to the phone's Download folder).

## Commands
- Tests: `cd frontend && npm test` · Dev in Chrome: `npm run dev` · APK: `bash scripts/build-apk.sh` then `powershell -ExecutionPolicy Bypass -File scripts\push-apk.ps1`, install from Files → Downloads on the phone.

## Next
- Phase 4: Help (3 buttons, Call 112, Text my contact), escalation ladder, `server/` dispatch server + dashboard, safety timer, simulated mesh.

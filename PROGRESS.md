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

## Next
- Phase 3: engine in a Web Worker; UI rewired to it (old HTTP client to `legacy/frontend-web/`); map draws the bundled roads, no tiles; Preferences + Geolocation; theme tokens; APK on the phone.

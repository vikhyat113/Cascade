# Repo audit (Phase 0)

Branch `nightway-android` starts from `main` at `e6d8b36` ("ini frontend"). The work before that is also kept on the `backup-history` branch.

## What exists and works

| Area | What it is | State |
|---|---|---|
| `backend/` | Python FastAPI engine: facts + freshness (4 statuses, decay, weakest-link), street-graph routing (scipy Dijkstra), 6-part risk intervals, opening-hours parser, transit (timetable + realtime), cab model, live feed simulator, planner (walk / bus / cab, best-expected-worst arrival, Safest/Balanced/Fastest, Plan B, leave advice), re-planner with hysteresis + change log, plain-language simple view, need-now, heatmap, 8 scenarios | **Works**: 53 pytest tests (~2 s), 8/8 scenarios pass with 0 invalid outputs |
| `data/` | Cached real data for **Noida (Sector 18, 4 km)**: OSMnx walk/drive packs, 371 OSM facilities + 21 lamps, Open-Meteo forecast; hand-built night timetable on real stops; seeded synthetic incident history | Works offline |
| `scripts/` | fetch_graph / fetch_pois / fetch_weather / build_transit / gen_incidents / fetch_all, run_scenarios, record_demo | Works (needs internet only to re-download) |
| `frontend/` | React + Vite + TS + Tailwind **simple phone UI** (Home → Result → Trip → Open now, Help, Demo drawer), Leaflet map, copy deck `src/copy/en.ts` + `hi.ts` + banned-word/length test (Vitest), service worker | Works against the Python server; builds clean |
| docs | README, ASSUMPTIONS, DEMO, screenshots | Describe the web version |

## Plan for the Android app

The new spec says **the phone does the thinking**: engine in TypeScript, data bundled in the APK, no server needed. So:

| Decision | Item | Why |
|---|---|---|
| **Reuse** | `frontend/` becomes the Capacitor app root (`frontend/android/`, `frontend/src/engine/`, `frontend/src/data/`). Screens, map, copy deck, copy test, theme tokens. | Already the phone-first UI the spec describes (same screens, same words, same rules). |
| **Reuse** | `data/` + `scripts/` behind a new `tools/build_data.py` (`npm run data`) that turns the cached data into compact JSON in `frontend/src/data/`. | Real OSM / Open-Meteo data already cached; no need to hit Overpass again. |
| **Refactor (port)** | `backend/app/core/*` and `backend/app/presentation/simple_view.py` → TypeScript in `frontend/src/engine/` (freshness, clock, hours, graph + Dijkstra with binary heap, risk, transit, cab, feeds sim, planner, re-planner, simple view, need-now, scenarios). | Same rules, same tests, now running on the phone. The Python version stays as the reference the port is checked against. |
| **Keep (not shipped)** | `backend/` stays where it is as the reference implementation and laptop-side scenario oracle. | Moving it would break its paths and tests; it is not replaced, just not bundled. |
| **Replace → `legacy/`** | `frontend/src/api.ts` (HTTP calls to the Python server), `frontend/src/lib/connection.ts` (server status polling), `frontend/public/sw.js` (web service worker; the APK serves files locally) → `legacy/frontend-web/`. | The app talks to its in-app engine instead. **Moved in Phase 3** (`git mv`, history kept). The Demo drawer's `demoApi.ts` was re-pointed at the engine in place. |
| **Replace → `legacy/specs/`** | old `SPEC.md` (web) and `UI_SPEC.md` (simple web UI). | This SPEC.md replaces all earlier prompts. |
| **New** | `server/` (Node + Express dispatch server for SOS), `scripts/build-apk.sh`, Capacitor config, `src/theme.ts`, `src/config.ts`, `PROGRESS.md`, `ENVIRONMENT.md`. | Spec sections 9, 12. |

## Stack check (spec §3)

* **Capacitor 6.2** (not 7): Capacitor 7 needs JDK 21; the spec and this machine use JDK 17. Capacitor 6.2 = Android Gradle Plugin 8.2, compileSdk 34, minSdk 22.
* React 18 + Vite 6 + TypeScript + Tailwind v4 + Leaflet (canvas renderer) + Vitest: already in `frontend/`.
* Demo area: the repo already defines it (`backend/config.yaml`: Noida, center 28.5705, 77.3229, radius 4 km), so the "FILL THESE 3 LINES" block is not needed. The spec's 2.5 km default would cut off the demo persona's home in Sector 12 (3 km from the centre), so the bundled graph keeps the repo's 4 km radius. It stays well under the 8 MB limit; see PROGRESS.md for sizes.

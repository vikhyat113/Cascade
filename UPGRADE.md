# UPGRADE PROMPT: port `changes` features into `main`, move to Nagpur and Butibori, real bus routes with transfers, HERE maps, deviation warning, always-on SOS

> How to use: in your clone of `vikhyat113/Cascade`, save this as `UPGRADE.md` in the repo root, start Claude Code, and say:
> **"Read UPGRADE.md and SPEC.md. Execute UPGRADE.md phase by phase, committing after each phase. Keep SPEC.md's rules (simple UI, banned words, four data statuses, offline first) unless UPGRADE.md says otherwise. Update PROGRESS.md and CHANGES.md as you go."**

---

## 0. Ground rules

- Base: current `main` (the Capacitor + on-device TypeScript app). Create branch `nightway-nagpur` from `main`. Commit after every phase and tag `up-N`. **Do not push** unless I ask. Never rewrite history. Never delete working features: move replaced code to `legacy/`.
- **Do NOT merge `origin/changes` into `main`.** `changes` branched from the very first commit (`e6d8b36`) and is built on the old web version (Python backend + browser frontend). `main` moved to an on-device TypeScript engine. A merge would conflict everywhere and bring back server-only code. Instead **port** features: read them with `git fetch origin changes`, `git diff --stat e6d8b36 origin/changes`, `git show origin/changes:<path>`, and re-implement them in `frontend/src/` (TypeScript, on-device) plus build-time Python scripts for data.
- **Offline first stays.** The app must still plan, show the map layers that were bundled, and trigger SOS with no internet. Anything that needs the internet (HERE tiles, HERE traffic, live weather) is an **optional online extra with a clean fallback**.
- **Never fake "real time".** Where a source is simulated, say so in the Demo drawer data check and in the docs. Where a real live source exists and answers, it is KNOWN; when it fails, it ages into OUTDATED/UNKNOWN. Do not present simulated data as live to users.
- Words in `copy/*.ts` (English and Hindi), look in `theme.ts`, numbers in `config.ts`. All new strings must pass the banned-word and length tests (shorten the long labels that `changes` added, e.g. "Native grid", "Missing share", "Licence": move technical ones to a "Details" view reachable from the Layers button or the Demo drawer).
- Keep the normal UI minimal. New things (layers, other ways, heatmap) live behind small buttons ("Layers", "Other ways"), never on the main screens by default.
- Ask me only for: the HERE API key (tell me to paste it into `frontend/.env.local`, never into chat or git), and to confirm Home/Work places after you geocode them. Otherwise decide, log in `ASSUMPTIONS.md`, continue.
- Performance budget: first screen usable in < 2 s on the phone; heavy layer data is **lazy-loaded from bundled asset files** (fetch on first use), not imported into the main JS bundle.

---

## 1. What I found in the repo (verify with git, don't trust blindly)

**`main` already has:** Capacitor 6 Android app; TypeScript engine in a Web Worker (`frontend/src/engine/`: freshness, world, planner with modes `walk|bus|metro|cab`, risk, transit, replanner, services, simpleView, scenarios, sim feeds/events); screens Home / Search / Result / Trip / OpenNow / Help; SOS ladder + dispatch client + safety timer + simulated mesh + BLE (`frontend/src/sos/*`, Kotlin `MeshPlugin.kt`, `MeshService.kt`, `BleMesh.kt`, off by default via `MESH_REAL`); Demo drawer; Node dispatch server in `server/`; Leaflet map (`MapCanvas.tsx`: OSM tiles in a night palette online, bundled roads offline). **The area is Noida (Sector 18)** (`frontend/src/data/meta.json`, `backend/config.yaml`). The bus timetable is **synthetic** ("hand-built illustrative timetable on real OSM stop locations", e.g. invented "Night bus N1"). The planner's transit candidates use **one bus route per trip (no transfers)**. The SOS button exists only on the Trip screen.

**`changes` adds (commits `8e87cfb`, `cea5790`, `ed77ac6`, `70629c9`, `1fb0b8a`):**
1. **Area polygon support:** `data/area.geojson`, `scripts/check_area.py`, `backend/app/adapters/area.py`, `area_polygon` + `area_buffer_m` in `backend/config.yaml`, graph clipped to the polygon.
2. **Map layers:** `LayerPanel.tsx` (~1000 lines) + `MapCanvas.tsx` rendering: **VIIRS night lights** (`scripts/fetch_viirs.py`, `data/viirs_ntl.json`, `viirs_history.json`, optional `use_viirs_lighting_prior`), **thermal** (`scripts/fetch_thermal.py`, `data/thermal_lst.json`), **weather grid** (`scripts/fetch_weather_grid.py`, `data/weather_grid.json`, `weather_climatology.json`), **moon light** (`backend/app/core/astronomy.py`, "computed, not measured"), **facilities** with an "open at this time" filter and "include unlisted hours", opacity, "follow clock", smoothing, layer info (source, licence, missing share), "coverage area" outline, plus a **heatmap** (`/heatmap`, `core/heatmap.py` also exists on main's backend).
3. **Multi-route engine:** `backend/app/core/routing.py`: Dijkstra + **Yen's K-shortest loopless paths** with safety-aware cost (`time + lambda * risk_effective * length * k_exposure`, `risk_effective = (1-u)*mid + u*hi`), corridor restriction, diversity filter (overlap + cost ratio), worst-case evaluation (safety, ETA, unknown-lighting share, outdoor exposure, safe-haven proximity), hard feasibility filter, **Pareto dominance**, honest tie detection, plain-language explanations. UI: `CompareRoutesSheet.tsx` ("Compare choices", "Recommended", "Safety or speed", "Show other choices", "How choices compare"). Tests: `backend/tests/test_multi_route.py`.
4. **Live weather refresh** (`backend/tests/test_weather_live.py`, `live_weather` flags) and new source entries in `config.yaml` (`viirs_ntl`, `thermal_lst`, `weather_grid`), freshness `unusable_factor`, risk/planner config blocks.
5. Backend model/config: risk weights `{lighting .24, incident .24, isolation .20, traffic .10, weather .10, emergency .12}`, planner lambdas `[0, .5, 1, 2, 4]`.

Write `UPGRADE_AUDIT.md` first: for each item above, whether `main` already has an equivalent, what you will port, and where it lands in the TS engine/UI.

---

## 2. Phase U1: move everything to Nagpur and Butibori (area + data)

The team lives in the Nagpur and Butibori region (Butibori is roughly 30 km south-west of central Nagpur; IIIT Nagpur is in the Butibori area). **Geocode the real places at build time** (Nominatim, one polite request each, cached): "Butibori", "IIIT Nagpur", "Sitabuldi, Nagpur", "Nagpur Railway Station", and pick sensible demo places. Verify coordinates against the map before using them.

Because the region is a long corridor, do **not** use one big radius:
- Use **`area.geojson` with named zones** (port `area.py`, `check_area.py`): (a) **Nagpur core** (radius ~4 km around Sitabuldi/Sadar/Dharampeth side), (b) **Butibori MIDC + IIIT Nagpur** (radius ~3 km), (c) a thin **connecting corridor** (buffer ~500 m along the main road between them, e.g. the NH-44 / Butibori-Nagpur road, found from the OSM road network).
- Walk graph at full detail in zones (a) and (b); in the corridor keep only major roads (motorway/trunk/primary/secondary/tertiary) so bus and long-distance legs can connect. Keep `graph.json` under ~15 MB (compact arrays, simplified geometry); measure planning time on the phone and keep it under ~1.5 s.
- Rebuild **all** data for the new area with the existing build scripts (`tools/build_data.py` and the `scripts/fetch_*.py` ported from `changes`): graph, POIs (incl. hospitals, clinics, police, pharmacies, fuel, ATMs, bus stops, metro stations), lit tags and lamps, weather snapshot, VIIRS/thermal/weather grid for the new bbox, synthetic incident grid (seeded, regenerated for Nagpur), `meta.json` (city name "Nagpur and Butibori", centre(s), timezone `Asia/Kolkata`, real/synthetic lists updated).
- Update defaults in `meta.json` (`ui_defaults`: home/work/start) to real Nagpur/Butibori places (e.g. start at IIIT Nagpur, Home near Nagpur city, Work at a central place), after asking me to confirm. Remove every remaining Noida reference (grep for "Noida", "Sector 18", "Sector 12").
- Fallback sample data must still allow the app to run if any download fails.
- Tests and scenarios must be updated to use Nagpur/Butibori fixtures and still pass.

---

## 3. Phase U2: port the layers (street lights, night lights, heatmap, facilities, weather)

Re-implement in TypeScript, on-device, from bundled files:
- **Street lights:** the real `lit` tags and street-lamp points from OSM as a map layer (lit streets bright, unlit dim, unknown neutral) and as an input to risk (already partly in `risk.ts`; confirm).
- **VIIRS night lights** as an optional lighting prior for edges with unknown lighting: port `use_viirs_lighting_prior` into `risk.ts`/`world.ts` (default **on only if** it is shown to reduce UNKNOWN share; always keep the status PROBABLE, never KNOWN; label "from satellite").
- **Heatmap:** night-safety heatmap by hour (slider 22:00-06:00, follows the app clock) built from the synthetic incident grid + lighting + isolation; labelled "estimate" in plain words; details (synthetic) in Demo drawer.
- **Facilities layer:** hospitals/police/pharmacies/24h places with "Open now" (against the app clock) and "Include unlisted" (UNKNOWN hours shown with a "Not sure" look).
- **Weather layer, thermal, moon light:** port as optional layers inside the **Layers** panel (small button on the map). Keep the honest notes ("computed, not measured", "smoothed for display"), shortened to pass the copy rules.
- **Layers panel:** one small round "Layers" button on the map opens a simple sheet: Streets lit, Safety heat, Help places, Weather, Night lights (the rest under "More"). Each toggle has an opacity control only under "More". Plain words only; layer details (source, licence, missing share, native grid) live under a "Details" link and in the Demo drawer data check.
- Layer data files load lazily on first toggle. If a layer file is missing or older than the area, show "Not available here" instead of an error.
- Tests: layer loaders, bbox/outside-area handling, heatmap hour logic, VIIRS prior effect on UNKNOWN share.

---

## 4. Phase U3: multiple routes (Yen's K-shortest) and "Other ways"

- Port `routing.py` to `frontend/src/engine/` (e.g. `kshortest.ts`): Dijkstra (reuse the existing heap) + **Yen's K-shortest loopless paths** with the safety-aware edge cost, corridor restriction for speed, diversity filter, worst-case evaluation, hard feasibility filter, Pareto marking, honest tie detection, plain explanations.
- **Golden tests:** generate fixtures with the Python version (a build-time script on a small sample graph) and assert the TS version returns the same ranked path sets and safety/ETA numbers within tolerance. Fix any mismatch in the TS port.
- Result screen stays minimal: the best way plus the existing tabs (Safest / Balanced / Fastest). Add an **"Other ways"** link (small) that opens the compare sheet: up to 4 ways on the map in different colours, each with arrive time, Safe/OK/Be careful, outdoor minutes, and a one-line "why" (e.g. "Longer, but lit and near open shops."). Mark a close call plainly ("Close choice. Safest picked."). Words and length must pass the copy tests; hide Pareto terms from users.
- Walking K-paths must stay fast on the phone: cap K (default 4), cap search corridor, and run in the worker.

---

## 5. Phase U4: remove cab, add real bus and metro routes with transfers

**5.1 Remove cab entirely.** Delete `cab` from `Mode`, the planner candidates, `cab_availability` facts/sources, `cabWait`, copy strings (EN/HI), Demo drawer toggles, scenarios and tests (move any removed code to `legacy/`). The app now offers: **walk, bus, metro, and walk + bus/metro combinations with transfers**, plus "wait at a safe place". Update `simpleView` and the `Backup` logic: the Backup for a weak bus leg is now "walk" or "wait at a safe place" (never a cab).

**5.2 Find real bus data for Nagpur and Butibori (do this before building the router; write findings to `docs/TRANSIT_DATA.md`).** In this order, stop at the first source that passes the coverage test:
1. **OpenStreetMap route relations** via Overpass for the area bbox: `relation[route=bus]`, `relation[route=minibus]`, `relation[route=subway|light_rail|tram]`, `relation[type=route_master]`, plus `public_transport=platform|stop_position|stop_area` and `highway=bus_stop`. Extract ordered stop lists, route `ref`/`name`/`operator`, and any `interval`, `opening_hours`, `fare` tags. (A tool such as `prism` can also turn OSM routes into GTFS if useful.)
2. **A published GTFS feed:** check the Mobility Database catalog (`MobilityData/mobility-database-catalogs` on GitHub), Transitland feed listings, and Maha Metro / Nagpur Mahanagar Parivahan / Aapli Bus / MSRTC pages for an open GTFS for Nagpur. (I could not confirm one exists. Do not assume.)
3. **`data/manual_bus_routes.csv`** (template to create, columns: `route_ref, route_name, direction, stop_order, stop_name, lat, lon (optional), first_bus, last_bus, headway_min`): I will fill this with real Aapli Bus/other routes I know. The builder snaps stop names to the nearest OSM stop (or Nominatim) and flags unmatched rows.
4. **Coverage test:** a source is usable if the area has at least ~5 routes with >= 6 stops each that connect the demo places. If none passes, say so plainly and use the fallback below.
**Fallback (clearly labelled `synthetic: true`, never "live"):** real OSM stops joined by plausible corridor routes, with assumed headways. Mark facts `inferred`/`prior`. Add the sentence "bus times are estimated" to the docs and the Demo drawer data check.

**5.3 Honest service hours.** Real city buses may not run at 2 AM. **Never invent night service.** If a route has real first/last-bus or `opening_hours`, use it (KNOWN/PROBABLE). If service hours are unknown, the status is **UNKNOWN** ("Not sure buses run now") and the plan must show a Backup (walk or wait at a safe place). Add a Demo drawer toggle **"Pretend night buses run (simulated)"** so judges can see transfers working; label it simulated.

**5.4 Transfer routing (`A to B`, or `A to C then C to B`).** Extend `frontend/src/engine/transit.ts` and `planner.ts`:
- Build a transit network: stops (cluster stops within ~60 m of the same name), routes with ordered stops and headways, and **transfer edges** between stops within ~250 m (walking time from the street graph, or straight-line x 1.3 as a fallback).
- Search (RAPTOR-lite or time-dependent Dijkstra over (stop, time)), **up to 2 transfers**, so the app finds: walk -> bus X -> (transfer at C) -> bus Y -> walk. Prefer direct trips when they are about as fast; penalise each transfer (default 5 min + the real expected wait + a small risk penalty for waiting outdoors, higher if the transfer stop is unlit/isolated).
- Waits: expected = headway/2, worst = headway; status PROBABLE if headway is inferred, UNKNOWN if missing. Use the freshness engine for each leg's status; the weakest leg decides the plan's warning.
- Output steps for the UI in plain words: walk 6 min -> Bus 12 (14 min) to Sitabuldi -> change here, wait about 8 min -> Bus 45 (20 min) -> walk 4 min. Show transfer stops as markers. The Result screen shows at most 4 icon steps plus "More steps" for longer trips.
- Metro (Nagpur Metro stations/lines if present in OSM) uses the same network as another route type.
- Tests: direct beats transfer when similar; transfer is found when no direct route exists; UNKNOWN hours -> Backup shown; no invented night service; max-transfer cap; performance < 1.5 s on the bundled network.
- Also expose "Places on the way" for transfer stops (is there an open shop or police point near the transfer stop?).

**5.5 Optional online cross-check (HERE Public Transit), only if the key exists and the call succeeds:** query HERE Public Transit for the same origin/destination and show it in the Demo drawer data check as a comparison. If it returns nothing for Nagpur, say "no HERE transit data here". Do not depend on it.

---

## 6. Phase U5: SOS always on top

- A persistent **SOS button on every screen** (Home, Search, Result, Trip, Open now, Layers, Compare, About), fixed top-right, above all sheets, banners and the map, minimum 56 px, red, label "SOS" with an icon, never covered by the status pill or banners (move the pill left or below). It must also remain visible while a trip is running and after a plan is started or booked (there is no booking now, but never hide it in any state).
- One tap opens the existing Help sheet immediately (no confirmation first); keep **Call 112** always at the top of that sheet. Add an accidental-press guard only inside the sheet (the user chooses danger/doctor/not sure), never before it opens.
- It works offline and while GPS is slow (use the last known fix and say "Using last place").
- Demo drawer: keep a "hide SOS" off. SOS cannot be hidden by any flag in release builds.
- Tests: component renders on all screens; z-order test; keyboard/screen-reader label; 360 px layout check; Hindi label.

---

## 7. Phase U6: route deviation warning (works offline)

During a trip, compare the live GPS fix with the planned way:
- Compute the distance from the user to the nearest point on the planned polyline (and a progress index along it). Ignore fixes with poor accuracy (> 50 m) and use hysteresis: warn only after 3 consecutive fixes beyond the threshold.
- **Levels** (thresholds in `config.ts`, tuned for walking): **off the way** at > 60 m for > 20 s -> a gentle banner "You are off the way." with **New way** (re-plan from here) and **I'm fine**. **Far off** at > 250 m or > 3 min -> stronger banner "You are far from the way." with **New way**, **Call someone** (prefilled SMS) and **SOS**. On a bus/metro leg, use the vehicle's expected line and a larger threshold; if the user is unexpectedly stationary for > 5 min at night, ask "Are you OK?" (reuse the safety-timer notification).
- "I'm fine" snoozes warnings for 3 minutes. "New way" re-plans with the current position and the remaining deadline, with the usual hysteresis and one plain banner.
- Everything runs on-device from the bundled graph.
- **Demo helpers (Demo drawer):** "Walk the way" (animates a fake GPS along the route at 1x/10x) and "Wander off" (jumps the fake GPS 80 m / 300 m off) so judges can see warnings and re-planning in a few seconds in daytime. Mark simulated location in the Demo drawer and show the "Demo time" chip.
- Tests: distance/progress maths on fixtures, hysteresis, thresholds, snooze, re-plan from a deviated point, no warnings during normal GPS jitter.

---

## 8. Phase U7: SOS ladder: "reach whatever you can"

Extend `frontend/src/sos/ladder.ts` (keep the existing statuses: Sending, Passed on, Help is aware, Not sure):
1. **Direct** to the dispatch server if reachable (police desk first for danger; hospital desk for medical).
2. If not, **mesh** (real BLE if `MESH_REAL` is on and verified; otherwise the simulated mesh) to a gateway.
3. **If the first destination (police) isn't acknowledged within N seconds**, move down the list automatically: nearest police -> nearest hospital/clinic -> fire station -> nearest **open place with people** (24 h pharmacy, fuel station, hotel) from bundled POIs. Show the next target by name and distance, and offer **Take me there** (walking way) and **Call** (`tel:` if the POI has a phone tag). Each step has a short timeout (default 20 s; 8 s in demo mode).
4. Always show **Call 112** and **Text my contact** (prefilled SMS with a map link).
5. Honest status words only; never claim help is aware unless an acknowledgement came back. Log each step for the Demo drawer ("Tried police desk: no answer. Trying hospital desk.").
6. Add a "nearest reachable help" computation that uses the mesh peer list (real or simulated) so the app can say plainly what it could reach ("Reached 2 phones. No police link yet.").
- **Bluetooth hardening (real BLE):** re-read `docs/BLE_STATUS.md`; add a pre-flight check (Bluetooth on, permissions granted, foreground service running, advertising supported); a visible plain status line (peers seen, last packet); safe auto-fallback to the simulated mesh. Do not claim multi-hop works unless tested with 3 Android phones; record what was and was not verified in `docs/BLE_STATUS.md`.
- Tests: ladder escalation order and timeouts, fallback to hospital when police fail, acknowledgement handling, no false "aware" status.

---

## 9. Phase U8: HERE maps for the real-time look (optional online layer)

- Add `map.provider: "here" | "osm"` to `config.ts` (default `here` when a key exists, else `osm`). The key comes from `frontend/.env.local` as `VITE_HERE_API_KEY` (git-ignored; add `.env.example`). Ask me to paste the key there; never print it, never commit it. Remind me to **restrict the key** (HERE console) because an APK can be unpacked.
- **Tiles:** use HERE Raster Tile API (night style, e.g. `explore.night`, verify the current v3 URL and style names in HERE's docs) as the online tile source in `MapCanvas.tsx`, with the required **"© HERE" attribution** visible. If the key is missing, the request fails, or the phone is offline, fall back to the existing OSM night tiles, then to the bundled road drawing (as today). Never show two basemaps at once.
- **Do not bulk-download or cache HERE tiles for offline use** (check HERE's terms); offline uses the bundled roads only.
- **Optional live traffic:** if the key works and HERE returns traffic flow/incident data for the Nagpur/Butibori bbox, use it as a **real** `traffic_live` source (KNOWN while fresh, ages to OUTDATED/UNKNOWN when it stops answering), replacing the simulated traffic. If HERE has no coverage there (empty/denied), keep the simulated traffic, say "traffic is simulated" in the Demo drawer data check, and never label it live.
- Free allowances are **per product** (check HERE's current plan page: tiles, routing, public transit, traffic each have their own free monthly thresholds). Add a small request counter in the Demo drawer, throttle calls, and cache responses in memory for a few minutes to stay within limits.
- "Working in real time" must come from true things: the GPS dot moving, the live/offline pill, real weather when online, HERE traffic if it exists, re-planning events, and the Demo "Walk the way" animation (clearly marked). Not from faked live labels.

---

## 10. Phase U9: polish, tests, APK

- Update copy (EN + HI) for every new string; run the banned-word/length tests; shorten anything that fails.
- Update scenarios (remove cab; add: transfer route; no night bus (UNKNOWN) -> Backup; deviation; police not acknowledged -> hospital; HERE tiles fail -> OSM -> roads; all live info lost).
- `npm test` passes; `npm run build` passes; build the APK (`scripts/build-apk.sh`) and install it on the connected phone.
- Manual checks on the phone: airplane mode (plan + SOS + layers still work); HERE key missing (falls back cleanly); SOS visible on every screen; deviation warning with "Wander off"; transfer route with the "Pretend night buses run" toggle; the Nagpur/Butibori area loads fast; layers lazy-load; 360 px and large font.
- Update `README.md`, `DEMO.md` (new demo script in Nagpur/Butibori), `docs/TRANSIT_DATA.md`, `docs/BLE_STATUS.md`, `CHANGES.md`, `PROGRESS.md`. In `README.md` list **what is real vs simulated** after this upgrade.

---

## 11. Time-boxing and the cut order

The whole list is large and the team has limited hours. Do the phases in this order and keep the app buildable after each: **U1 area -> U5 SOS on top -> U4 cab removal + buses -> U6 deviation -> U2 layers -> U3 other ways -> U7 ladder -> U8 HERE -> U9 polish.** If time runs short, cut in reverse: HERE traffic and public-transit cross-check first, then moon/thermal/weather-grid layers, then Yen's "Other ways" (keep single best way), then the extended ladder (keep the current ladder). **Never cut:** the Nagpur/Butibori area, SOS on every screen, cab removal, honest bus data, deviation warning, offline behaviour.

At the end of each phase, update `PROGRESS.md` with: done, next, what is unverified, and the exact commands to build and demo. At the very end, print the APK path and a short list of real vs simulated data.

Start now: read `UPGRADE.md` and `SPEC.md`, write `UPGRADE_AUDIT.md`, create the branch, and begin Phase U1.

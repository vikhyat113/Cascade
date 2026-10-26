# Changes after the build (add-on mode)

Each request: what it was, which layer it touched, what was done.

## 1. Street map from the web version back (stable-1)
- **Request**: "the map view we had initially in web has gone, fix that too".
- **Layer**: map component (`components/MapCanvas.tsx`), theme CSS (`index.css`), config (`config.ts` → `map`), Capacitor config (User-Agent).
- **Rule check**: the spec says "no downloaded tiles" so the map works offline. Kept that promise with the simplest version: street tiles (OpenStreetMap, night palette, same look as the web version) **only while they load**; offline or on tile errors the app hides them and draws its bundled road network, as before. Never both at once.
- **Also fixed**: on the Trip screen the map was zoomed far out (it fitted the way to the Result screen's taller sheet and ignored the next-step card); it now re-fits when the sheet settles and leaves room for the card.
- **Checked**: tests pass; browser run at 360 px online (street map, way framed) and offline (road map only, "Offline: using saved info").

## 2. Map fixes (commit "fixed map issue")
- **Layer**: map component, config (`map.boundsFactor`), APK copy script.
- The OpenStreetMap credit sat bottom-right, always under the sheet (the tile policy needs it visible): now top-right.
- The map could be panned far from the area the app has data for (offline: an empty dark map): it now stays within 2.5 × the area radius.
- `scripts/push-apk.ps1` explains a locked phone / "charging only" USB instead of printing PowerShell errors.

## 3. Real Bluetooth relay (Phase 7, commit "native added")
- **Layer**: native plugin (Kotlin), sos transport, Demo drawer. Off by default (`MESH_REAL`); see docs/BLE_STATUS.md.

## 4. UPGRADE U1: area moved to Nagpur and Butibori (tag up-1)
- **Layer**: data build scripts (`scripts/area.py`, `geocode_places.py`, `fetch_graph.py`, `fetch_pois.py`, `fetch_weather.py`, `build_transit.py`), `tools/build_data.py`, config, engine (`world.ts` zones), map bounds, location check.
- Zones instead of one radius; every Noida reference removed outside `legacy/`. Old Noida data stays in git history.

## 5. UPGRADE U5: SOS on every screen (tag up-5)
- **Layer**: new component `SosButton`, App (Help opens with the best place), Help sheet (last place / no place), copy (EN + HI), layout (pill left, cards lower), e2e test.

## 6. UPGRADE U4: cab removed, Metro + estimated buses, transfers (tag up-4)
- **Layer**: data (`scripts/build_transit.py`, docs/TRANSIT_DATA.md), engine (`transit.ts` itinerary search, `planner.ts`, `simpleView.ts`, `services.ts` speed-up, `risk.ts` closures), copy (EN + HI), Result steps, map change markers, Demo switch.

## 7. UPGRADE U6: deviation warning (tag up-6)
- **Layer**: engine (`deviation.ts`), position source (`lib/position.ts`, real or Demo fake GPS), App banners and re-plan, copy (EN + HI), config `deviation`, Demo drawer 10.

## 8. UPGRADE U2: map layers (tag up-2)
- **Layer**: data scripts (`fetch_viirs.py`, `fetch_weather_grid.py`), engine (`world.ts` satellite prior, `heatmap.ts`, `astronomy.ts`), worker layer data, `lib/layers.ts`, `screens/Layers.tsx`, map drawing, copy (EN + HI), config.

## 9. UPGRADE U3: other ways (tag up-3)
- **Layer**: engine (`kshortest.ts`, planner candidates + comparison, cache), simple view (`other_ways`, `close_text`), screens (`OtherWays.tsx`, Result link), map colours, copy (EN + HI), golden generator `tools/golden_routing.py`.

## 10. UPGRADE U7: help ladder (tag up-7)
- **Layer**: `sos/ladder.ts`, `sos/ble.ts` codes, engine `help()`, Help sheet, dispatch server (fire desk), Kotlin service flag, Demo drawer, copy (EN + HI), config.

## 11. UPGRADE U8: HERE online extras (tag up-8)
- **Layer**: new `lib/here.ts`, `demo/HereSection.tsx`; `MapCanvas.tsx` tile chain; engine `setRealTraffic` + State `realTraffic` / `synthetic()` / `ttlOf()`; feeds use HERE readings when present; config `map.provider`, `here.*`; `.env.example`, `.gitignore` (`.env.local`).


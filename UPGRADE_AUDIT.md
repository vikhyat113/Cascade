# UPGRADE audit: `origin/changes` vs `main`

Checked with git on 2026-10-26: `git log e6d8b36..origin/changes` = `8e87cfb`, `cea5790`, `ed77ac6`, `70629c9`, `1fb0b8a` (author prynopaws02).
`changes` branched from `e6d8b36` (first commit) and edits the **old web version** (Python backend + `api.ts` browser client). It is **ported, not merged**.

Base for the upgrade: `main` at `3d84cd1` = `origin/main` (`dcf463c`) plus one local commit (Bluetooth checklist + GPS check in the Demo drawer). Branch: `nightway-nagpur`.

| # | Feature on `changes` | Already on `main`? | What gets ported | Where it lands | Phase |
|---|---|---|---|---|---|
| 1 | **Area polygon** (`data/area.geojson`, `scripts/check_area.py`, `backend/app/adapters/area.py`, `area_polygon` / `area_buffer_m`) | No: one circle (`center` + `radius_m`) | Zones instead of one polygon: `load_area` on `changes` keeps only the **largest** polygon, so it can't express "Nagpur core + Butibori + corridor". New `scripts/area.py` builds a FeatureCollection of **named zones** (two circles + a 500 m buffer along the real main road). The pipeline clips graph / POIs to the zones; `meta.json` carries the zones; the TS `World.inArea` becomes point-in-zone. `check_area.py`'s validation ideas (lon/lat order, vertex cap, validity) are reused. | `scripts/area.py`, `data/area.geojson`, `tools/build_data.py`, `frontend/src/engine/world.ts` | U1 |
| 2a | **Street lights** (lit tags, lamps) | Yes: `graph.json` has `lit` + `lamps`, used in `world.ts` lighting facts and `risk.ts` | Map layer only (lit bright / unlit dim / unknown neutral) | `components/layers/` | U2 |
| 2b | **VIIRS night lights** (`fetch_viirs.py`, `viirs_ntl.json`, `use_viirs_lighting_prior`) | No | Build script for the new bbox → lazily loaded asset; optional PROBABLE lighting prior for UNKNOWN edges (only if it lowers the UNKNOWN share); a map layer | `scripts/fetch_viirs.py`, `engine/risk.ts`, layers | U2 |
| 2c | **Thermal** (`fetch_thermal.py`), **weather grid** (`fetch_weather_grid.py`, climatology), **moon light** (`core/astronomy.py`) | No | Optional layers under "More" in the Layers sheet; moon light computed on-device (TS port of `astronomy.py`), labelled "computed" | layers, `engine/astronomy.ts` | U2 (first to cut) |
| 2d | **Facilities layer** with "open at this time" + "include unlisted hours" | Partly: `needs.ts` (Open now, 4 types, UNKNOWN shown as Not sure) | Map layer reusing `services.ts` open-state against the app clock | layers | U2 |
| 2e | **Heatmap** (`/heatmap`, `core/heatmap.py`) | Python only (backend), not in the app | TS: per-hour grid from incidents + lighting + isolation, slider 22-06 following the app clock, labelled "estimate" | `engine/heatmap.ts`, layers | U2 |
| 2f | `LayerPanel.tsx` (~1000 lines, long technical labels) | No | **Rewritten small**: a round "Layers" button + a sheet with 5 plain toggles; technical details (source, licence, missing share, grid) under "Details" / Demo drawer. Long `changes` labels ("Native grid", "Missing share", "Licence") are not used on normal screens | `components/LayersSheet.tsx` | U2 |
| 3 | **Yen's K-shortest + Pareto** (`core/routing.py`, `CompareRoutesSheet.tsx`, `test_multi_route.py`) | Partly: `planner.ts` makes walk candidates at λ ∈ {0,0.5,1,2,4} + one penalty alternative, dedupes, labels Safest/Balanced/Fastest | `engine/kshortest.ts` (Yen on the existing heap Dijkstra, corridor-limited, diversity filter, worst-case eval, Pareto, tie detection); golden fixtures generated from the Python version; small "Other ways" sheet | engine + `screens/OtherWays.tsx` | U3 |
| 4 | **Live weather refresh** + new source entries | Yes, differently: the app probes Open-Meteo `current` every 15 min (real, KNOWN while fresh) | Source entries for the new layers (synthetic flags honest) in `config.ts`; nothing from the backend route | `config.ts` | U2 |
| 5 | Risk weights / lambdas | Same values already in `config.ts` (`.24/.24/.20/.10/.10/.12`, λ `[0,.5,1,2,4]`) | Nothing to port | n/a | n/a |
| 6 | `frontend/src/lib/saved.ts` + `saved.test.ts` edits | `main` rewrote `saved.ts` for Capacitor Preferences | Ignored (old web localStorage version) | n/a | n/a |
| 7 | `data/*` regenerated for Noida (graphs, incidents, weather) | n/a | Ignored: the area moves to Nagpur and Butibori, everything is rebuilt | n/a | U1 |

**Not in `changes`, new in UPGRADE**: Nagpur / Butibori area (U1), SOS on every screen (U5), cab removal + real bus data + transfers (U4), deviation warning (U6), extended SOS ladder (U7), HERE tiles / traffic (U8).

Order (UPGRADE §11): U1 → U5 → U4 → U6 → U2 → U3 → U7 → U8 → U9.

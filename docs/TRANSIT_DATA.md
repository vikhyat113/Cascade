# Transit data for Nagpur and Butibori

Checked 2026-10-26 (UPGRADE §5.2), in the order the upgrade asks for. Builder: `scripts/build_transit.py` → `data/transit_schedule.json` → `frontend/src/data/schedule.json`.

## 1. OpenStreetMap route relations (Overpass, area bbox 20.88-21.24 N, 78.97-79.14 E)

| Mode | Relations | Result |
|---|---|---|
| bus / minibus / share taxi | **0** | No city bus route is mapped. Only 10 `highway=bus_stop` nodes in the three zones (Sitabuldi City Bus Stand, Sitabardi terminal, Khurana, Abhayankar Nagar, Railway Station, Nagpur Main Bus Stand, Khapri Depot, ...). |
| subway (Nagpur Metro) | 4 (2 lines × 2 directions) | **Usable, real**: Orange Line (Khapri ↔ Automotive Square, 18 stops) and Aqua Line (Prajapati Nagar ↔ Lokmanya Nagar, 20 stops), operator MahaMetro, tagged `interval=00:15:00`, `opening_hours=06:00-22:00`. |
| train | 9 | Long-distance trains (Rajdhani, Duronto, ...): not city transport, ignored. |
| `route_master` | 0 | - |

## 2. Published GTFS

* **Mobility Database** catalog (`feeds_v2.csv`): no feed for Nagpur. The only Indian entries near Maharashtra are Mumbai (BEST/KDMT, unofficial) and a small inactive MSRTC feed (Sangameshwar). Feeds whose bounding box covers Nagpur are either broken Australian/US boxes or the inactive national Indian Railways feed (intercity trains).
* **Web search** (Aapli Bus / Nagpur Mahanagar Parivahan / Maha Metro GTFS): nothing published found.
* Conclusion: **no open GTFS for Nagpur city buses or Nagpur Metro**.

## 3. `data/manual_bus_routes.csv`

Template created (header only): `route_ref, route_name, direction, stop_order, stop_name, lat, lon, first_bus, last_bus, headway_min`.
Fill it with real routes you know (one row per stop). Stops without `lat`/`lon` are matched by name to OSM stops; unmatched rows are printed. With `first_bus`, `last_bus` and `headway_min` the route's hours are **known** (PROBABLE, scheduled); without them, **unknown**. Re-run:

```bash
backend/.venv/Scripts/python scripts/build_transit.py && cd frontend && npm run data
```

## 4. Coverage test

Buses pass when there are ≥ 5 real routes with ≥ 6 stops connecting the demo places. **Today: FAIL (0 real bus routes).** Metro: real.

## What the app uses now

| Route | Source | Stops | Hours | Status in the app |
|---|---|---|---|---|
| Metro Orange, Aqua | OSM (real) | real stations | 06:00-22:00, every 15 min (OSM tags) | scheduled → PROBABLE; no metro after 22:00 (never invented) |
| E1 Butibori - Wardha Road - Sitabuldi | **estimated** | 2 real + 18 estimated | unknown (headway assumed 30 min) | UNKNOWN: "Not sure buses run now." + Backup |
| E2 IIIT Nagpur (Waranga) - Butibori | **estimated** | all estimated | unknown (30 min) | UNKNOWN |
| E3 Railway Station - Sitabuldi - Dharampeth | **estimated** | 5 real + 10 estimated | unknown (20 min) | UNKNOWN |
| E4 Sadar - Sitabuldi - Ajni | **estimated** | 2 real + 9 estimated | unknown (20 min) | UNKNOWN |

* "E" = estimated, so they are never mistaken for real Aapli Bus numbers. Routes follow real main roads between real places; estimated stops are named after the nearest locality or street and flagged `est: true`.
* **Bus times are estimated.** Nothing about them is shown as live. The Demo drawer switch **"Pretend night buses run (simulated)"** lets judges see transfers working; it is labelled simulated.
* Simulated "live bus positions" (Demo) apply only to routes with known hours.

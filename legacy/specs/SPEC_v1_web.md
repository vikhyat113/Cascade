# MASTER PROMPT — "NightWay" (placeholder name): Night-Time Decision Engine

> Paste this whole file as the first message, or save it as `SPEC.md` in the repo root and say: "Read SPEC.md fully and build it, following the build order."

---

## 0. Role and working style

You are the lead engineer on a 24-hour hackathon build (CASCADE '26, problem 1.1 "The City That Sleeps While You Work"). The team has 3 people (frontend, backend, AI/ML), all comfortable with web dev only. Build a **web app** (no native mobile).

Working rules:
- Work in **vertical slices**. After every phase, the app must run end-to-end and be demo-ready. Never leave the repo in a broken state.
- Keep dependencies minimal and well known. Prefer simple, readable code over clever code.
- Do not ask questions unless truly blocked. Make reasonable assumptions, list them in `ASSUMPTIONS.md`, and continue.
- Commit often with clear messages. Write a short `README.md` with run instructions (one command each for backend and frontend).
- Never put secrets in code. Read keys from environment variables (`.env`, git-ignored). Provide `.env.example`.
- Write unit tests for the freshness engine, the risk scorer and the planner (pytest). Tests must run in under 30 seconds.

---

## 1. Problem statement (verbatim essence)

Cities are designed for daytime workers, but millions of workers (security guards, nurses, factory workers, sanitation workers, delivery workers, call-centre employees) live on a night schedule. At 2:30 AM a worker may need food, medicine, transport, emergency help, or a safe route home. Existing navigation treats night as "just a different timestamp".

Build a **Night-Time Decision Engine** that understands how city conditions change through the night. It must consider:
- availability of public/private transport
- operating hours of essential services
- route safety and historical incident patterns
- weather and road closures
- worker's shift timing
- emergency facilities
- real-time changes and unreliable/incomplete data

Example: "I finish work at 2:15 AM and need to reach home by 3:00 AM." The system must **generate and continuously update the safest feasible plan**. It must **keep working when live data becomes unavailable**, and it must **distinguish KNOWN → PROBABLE → OUTDATED → UNKNOWN rather than confidently inventing information.**

This last sentence is the core of the judging. Make it visible everywhere in the product.

---

## 2. Product concept

The user tells the app:
- **Where they are** (tap on map, search an address, or "use my location" if available)
- **When** (a start time, or "I finish work at HH:MM")
- **Where they want to go** (destination) and optionally **a deadline** ("be home by 3:00 AM")
- Optional: persona (nurse / security guard / delivery worker / factory worker / call-centre), mode preferences (walk / bus / metro / cab), and a **risk preference slider** (fastest ↔ safest)

The app returns **ranked route plans** (usually 3: Fastest, Safest, Balanced), each with:
- ETA as a **range** (e.g. 02:51–03:04), not a single number
- Whether it is **feasible before the deadline** in the best case, expected case and worst case
- A **safety score as a range** with a breakdown (lighting, incident risk, isolation, traffic/closures, weather exposure, emergency proximity)
- Transport availability and **waiting time** (e.g. "last bus 02:40, PROBABLE")
- Essential services and emergency facilities along or near the route (open at that time?)
- A **data-trust badge for every fact**: KNOWN / PROBABLE / OUTDATED / UNKNOWN
- A one-line **plain-language explanation** ("Chosen because it keeps to lit main roads and passes an open pharmacy; bus timing is only PROBABLE so a cab fallback is included")
- A **Plan B** (contingency) for the weakest link

It then **keeps updating**: when facts expire, a source goes down, a closure appears or weather changes, the plan is recomputed and the **change log** shows exactly what changed and why.

### Extra features to include (priority order)
1. **Data Trust panel**: a live board of every data source with status, age, and reliability. This is the signature feature.
2. **Outage toggles**: buttons to kill individual sources (traffic, transit realtime, weather, incidents) or all live data, to demonstrate graceful degradation.
3. **Plan B / fallback logic**: automatic alternative if the main plan relies on OUTDATED/UNKNOWN facts.
4. **Safe-haven stops**: open 24h places, hospitals, police stations near the route where the user can wait or get help; suggest "wait at X until the 02:40 bus" when that is safer than walking.
5. **Leave-time advice**: "Leave 8 minutes earlier to be safe given PROBABLE bus timing."
6. **Need-now finder**: "I need medicine / food / ATM / hospital now": nearest OPEN place reachable with a safe route, with confidence of "open" (hours tagged = KNOWN, inferred = PROBABLE, missing = UNKNOWN).
7. **Persona presets** with different shift times and constraints.
8. **Night safety heatmap** by hour (slider 22:00 → 05:00).
9. **Scenario replay / stress harness** (see section 9) with a results table.
10. **Trusted-contact share link and SOS button** (simulated: shows who would be notified and nearest emergency facility).
11. **Offline mode**: everything keeps working from cache; clearly labelled.
12. **Natural-language input** ("I finish at 2:15 and need to reach Sector 12 by 3") via LLM with a regex/rule fallback.

---

## 3. Tech stack (do not deviate without reason)

- **Frontend:** React + Vite + TypeScript, Tailwind CSS, MapLibre GL JS (or Leaflet if simpler), Recharts for small charts. Must be **responsive** (judges may open it on a phone).
- **Backend:** Python 3.11+, FastAPI, Pydantic v2, uvicorn. SSE or WebSocket for live updates. SQLite (or plain JSON files) for caches and logs.
- **Geo:** OSMnx + NetworkX for the street graph and routing. Shapely/GeoPandas only if needed.
- **Optional LLM:** Groq API (key from `GROQ_API_KEY`) for request parsing and explanation wording. **LLM must never supply facts**; it only parses input and phrases explanations from structured facts. Always provide a rule-based fallback so the app works with no key.

---

## 4. Demo city and data

Parametrize the demo area in `config.yaml`:
```yaml
city_name: "<CITY>"
center: {lat: <LAT>, lon: <LON>}
radius_m: 4000          # keep small: fast to load and route
timezone: "Asia/Kolkata"
```
(Leave placeholders if not provided; make setting them a one-line change.)

### 4.1 Real data (download once, cache to disk, never hit public APIs live in the demo)
- **Street network:** OSMnx. Build separate `walk` and `drive` graphs, save as GraphML in `data/`. Keep edge attributes: highway type, length, lit (if tagged), maxspeed, name.
- **POIs / facilities:** Overpass (one cached script `scripts/fetch_pois.py`): hospitals, clinics, pharmacies, police, fire stations, fuel stations, ATMs, 24h shops/food, bus stops, metro/railway stations, street lamps (`highway=street_lamp`). Save to `data/pois.json`. Respect fair use: identifying User-Agent, ≥1 s between requests, retry with backoff, then cache.
- **Opening hours:** OSM `opening_hours` tag. Parse with a library (e.g. `opening_hours` parser) with graceful failure. **Coverage will be patchy. That is expected and useful**: tagged and recent = KNOWN, inferred from category = PROBABLE, no tag and no usable prior = UNKNOWN.
- **Weather:** Open-Meteo (no key). Fetch hourly forecast for the night once and cache; also support live refresh. Free tier is non-commercial and updates hourly: fine here. Credit the source.
- **Transit schedule:** use real GTFS if the city has an open feed; otherwise hand-build a small `data/transit_schedule.json` (routes, stops, night frequencies, last-service times). Schedule-only data = PROBABLE.

### 4.2 Simulated data (clearly labelled `synthetic: true` everywhere, including the UI)
- **Traffic:** baseline free-flow speed per edge from OSMnx (`add_edge_speeds`, `add_edge_travel_times`), multiplied by an hour-of-night factor curve (near free-flow at 02:00–03:00, small slowdowns near shift-change hours), plus per-road-class variance, plus scheduled **events** (accident, closure, waterlogging when weather says rain).
- **Live feed simulator:** emits readings with timestamp, random delay, and dropouts, so the freshness engine has real work to do.
- **Incident history:** seeded generator producing hour-dependent incident density on a grid, biased by real OSM proxies (isolated roads, no lit tag, far from open POIs, industrial/low-footfall areas). Must be reproducible (`seed` in config). Support loading a real CSV later via the same interface.
- **Lighting:** use real `lit` tags and street-lamp nodes where present; for edges with no information, use a **prior by road class** with a wide uncertainty interval and status UNKNOWN/PROBABLE. Never present missing lighting as fact.
- **Private transport availability (cab/auto):** time-of-night × area-density availability model, status PROBABLE, with wait-time range.
- **Road closures:** simulated feed with timestamps, plus scripted scenario closures.

---

## 5. Core model: facts and freshness (build this first, test it heavily)

Every piece of information the planner uses is a **Fact**:
```python
class Fact(BaseModel):
    key: str                # e.g. "traffic:edge:12345", "poi:open:hospital_7", "weather:rain_prob"
    value: Any
    source: str             # "osm", "open-meteo", "sim-traffic", "schedule", "prior", ...
    synthetic: bool
    observed_at: datetime   # when the world was last observed
    ttl_s: int              # how long it stays "fresh"
    reliability: float      # 0..1, source reliability
    kind: Literal["observed", "scheduled", "inferred", "prior"]
```

Status function `status(fact, now) -> KNOWN | PROBABLE | OUTDATED | UNKNOWN`:
- **KNOWN:** `kind == observed`, `age <= ttl`, `reliability >= 0.7`.
- **PROBABLE:** `kind in {scheduled, inferred, prior}` and still plausible for `now` (e.g. schedule says last bus 02:40), or an observed fact with `ttl < age <= 3*ttl` but still decaying with a computed confidence.
- **OUTDATED:** an observed fact with `age > 3*ttl` (or schedule data that contradicts newer observations). Value kept but flagged, confidence heavily discounted.
- **UNKNOWN:** no fact, or unusable. **Do not fill in a value.** Planner must treat it as an interval/worst-case.

Also compute `confidence in [0,1]` via a smooth decay (`exp(-age/ttl)` × reliability, clipped by kind). Provide:
- `aggregate_status(facts)` → **weakest-link** status plus a confidence product for a route or plan.
- Everything that reaches the UI carries `{value, status, confidence, source, age_s, synthetic}`.

**Never** let the LLM or the planner fabricate a value for UNKNOWN. UNKNOWN must widen the output interval and trigger warnings/Plan B.

---

## 6. Planner

### 6.1 Inputs
`origin, destination, start_time (or finish_time), deadline?, persona, prefs {risk_weight, modes, max_walk_m}`.

### 6.2 Candidate generation
- Compute multiple candidate paths by running shortest path with different edge cost weightings: `cost = time_s + λ * risk_edge * length`, for `λ` in e.g. {0, 0.5, 1, 2, 4}; add k-shortest variations; **deduplicate** near-identical paths.
- Modes: **walk-only**, **walk + public transport + walk**, **cab (drive graph) with availability wait**, **wait-at-safe-haven then move**. Transit is modeled via board/alight virtual edges at stops with waiting time from the schedule (realtime if fresh, else schedule = PROBABLE, else UNKNOWN).

### 6.3 Evaluation (every candidate gets the same evaluator)
Simulate the trip **forward in time** segment by segment (speeds depend on the hour; traffic facts applied per edge; closures reroute or invalidate). Produce:
- ETA interval `[best, expected, worst]`; feasibility flags vs deadline.
- Risk breakdown per segment and total, each as an interval `[lo, hi]`:
  - **lighting** (lit fraction of length, lamps density; unknown → wide prior)
  - **incident risk** (hour-aware grid density)
  - **isolation** (distance to nearest open POI / activity proxy; road class)
  - **traffic/closure exposure** (slowdowns, blocked edges)
  - **weather exposure** (rain/wind × walking distance outdoors)
  - **emergency proximity** (distance to nearest open hospital/police along route; open status with confidence)
- `safety_score = 100 * (1 - weighted_risk)` as `[lo, hi]`; weights configurable in `config.yaml` and adjustable by the risk slider.
- Overall **data confidence** = weakest-link aggregate over all facts used.

### 6.4 Selection
- Filter to **feasible** plans using the **worst case**, if any exist; else the best-case feasible ones with a loud warning; else "no feasible plan" plus the closest alternative.
- Rank by **robust safety**: maximise `safety_lo` (worst-case safety), tie-break by `expected` ETA.
- Output labelled options: **Fastest**, **Safest feasible**, **Balanced**, plus **Plan B** for the weakest dependency of the chosen plan.
- Generate **leave-time advice** and **safe-haven suggestions** when a plan has a weak link or long isolated stretches.

### 6.5 Continuous re-planning
- Background loop (every few seconds in demo time, speed-adjustable) advances a **simulated clock**, ingests feed updates, recomputes facts' status, and re-runs the planner for active plans.
- Push `plan_update` events (SSE/WebSocket) containing the new plan and a **change log entry** (`"02:21 Bus 14 status KNOWN → OUTDATED (no update for 9 min); switched to Plan B"`).
- Avoid flip-flopping: require a minimum score improvement or a status change before switching the recommended plan (hysteresis), and say so in the log.

---

## 7. API (FastAPI)

- `POST /api/plan` → create/compute a plan set. Body: origin, destination, start/finish time, deadline, persona, prefs.
- `GET  /api/plan/{id}` → current plan set. `GET /api/plan/{id}/stream` → SSE updates + change log.
- `POST /api/nl/parse` → natural language → structured request (LLM if key present, rules fallback).
- `GET  /api/trust` → all sources with status, age, reliability, synthetic flag.
- `POST /api/sim/outage` → `{source, enabled}` kill/restore a source (or `all`).
- `POST /api/sim/clock` → set speed/time. `POST /api/sim/scenario/{id}/run` → run a scripted scenario.
- `GET  /api/need-now?type=pharmacy&lat=&lon=&time=` → nearest open reachable places with route + confidence.
- `GET  /api/heatmap?hour=02` → safety heat grid.
- `GET  /api/health` → liveness + data version.

---

## 8. Frontend spec

Layout (desktop; collapses to tabs on mobile):
- **Left:** request form (origin/destination search or map-pick, time, deadline, persona, risk slider), NL input box, route option cards (Fastest / Safest / Balanced) showing ETA range, safety range, feasibility, trust badge.
- **Center:** map. Route polylines coloured by **risk** or by **data status** (toggle). Hover a segment → tooltip with its facts, status badges and sources. Markers for stops, open/closed services, hospitals/police, safe havens, closures, streetlight density layer, heatmap layer with hour slider.
- **Right:** **Data Trust panel** (source list with status pills, age, a mini timeline), **Change Log**, **Plan B** card, and the **Simulation drawer** (outage toggles, clock speed, scenario picker, "inject closure/rain/incident" buttons).
- **Bottom:** night timeline bar (e.g. 22:00 → 06:00) showing service-hour windows, bus last-service marker, user's trip window, and deadline.
- Badges: green KNOWN, blue PROBABLE, amber OUTDATED, grey UNKNOWN, with a legend and a small "SYNTHETIC" tag where applicable.
- Show uncertainty as **ranges and bands**, not single numbers.
- Polished, dark-friendly night theme; accessible contrast; works at 360px width.

---

## 9. Simulation and stress-test harness

Scenario files in `scenarios/*.json`:
```json
{
  "id": "rain_and_bus_outage",
  "seed": 42,
  "city": "default",
  "request": {"origin": "...", "destination": "...", "finish_time": "02:15", "deadline": "03:00"},
  "events": [
    {"t": "02:20", "type": "rain_start", "params": {"intensity": "heavy"}},
    {"t": "02:25", "type": "source_outage", "params": {"source": "transit_realtime"}},
    {"t": "02:35", "type": "road_closure", "params": {"edge_selector": "main_road_nearest_route"}}
  ],
  "expect": {"never_status_unknown_as_value": true, "plan_b_offered": true, "still_feasible": "maybe"}
}
```
Include at least these scenarios: (1) baseline calm night; (2) bus cancelled; (3) main road closed; (4) rain starts mid-trip; (5) conflicting sources (schedule vs observation); (6) **total live-data loss** (all feeds dead → app still produces a plan with downgraded confidence); (7) fully offline start; (8) service listed open but hours unknown.

Provide `scripts/run_scenarios.py` that replays each scenario deterministically and prints a **results table** (scenario, plan changed?, status transitions, max confidence drop, any invalid output). Expose the same results in a small UI page `/scenarios`. Assertions must verify the system **never invents values for UNKNOWN facts**.

---

## 10. Repo layout

```
/backend
  app/ (main.py, api/, core/{facts.py,freshness.py,planner.py,risk.py,transit.py,sim/}, adapters/{osm.py,overpass.py,weather.py,traffic_sim.py,incidents_sim.py,transit.py})
  tests/
  config.yaml
/frontend (Vite React TS)
/data (graphml, pois.json, schedule.json, cached weather)  # git-ignored large files, include small sample
/scenarios
/scripts (fetch_graph.py, fetch_pois.py, fetch_weather.py, run_scenarios.py)
README.md  ASSUMPTIONS.md  SPEC.md  .env.example
```

---

## 11. Build order (acceptance criteria per phase)

1. **Skeleton (hours 0–3):** repo, config, scripts to download graph/POIs/weather and cache them; FastAPI `/api/health`; React map showing the area. *Done when both run with one command each.*
2. **Facts + freshness engine (3–6):** models, status function, aggregation, simulated clock, tests. *Done when tests cover the four statuses and decay.*
3. **Basic planning (6–10):** `/api/plan` with walk routes, ETA ranges, lighting/incident/isolation risk, 3 labelled options on the map.
4. **Transit + services + weather (10–14):** schedule-based transit with PROBABLE waits, open-now logic for POIs, weather exposure, emergency proximity, Plan B.
5. **Live loop + simulation (14–18):** feed simulator, outage toggles, SSE updates, change log, hysteresis, Data Trust panel.
6. **Stress harness + polish (18–22):** scenarios, results page, need-now finder, heatmap, persona presets, NL parsing, mobile layout.
7. **Docs and demo (22–24):** README, architecture diagram (mermaid), `DEMO.md` script, record a backup demo video, final bug-fix pass. **Feature freeze at hour 20.**

---

## 12. Demo script to support (design the UI for this)

1. Enter "I finish at 2:15 AM, need home by 3:00 AM" → three plans appear with ranges and badges.
2. Open the Data Trust panel: show KNOWN/PROBABLE/UNKNOWN sources, including a service with no opening hours (UNKNOWN, not guessed).
3. Kill live traffic and transit realtime → statuses go OUTDATED, plan re-computes, change log explains, Plan B appears.
4. Kill **all** live data → app still returns a plan, confidence drops visibly, nothing is invented.
5. Trigger heavy rain and a road closure → re-plan with hysteresis.
6. Use need-now: "pharmacy" → nearest open one with route and confidence.
7. Show the scenario results table.

---

## 13. Hard rules (judging-critical)

- **Never invent data.** UNKNOWN stays UNKNOWN, shown as such, and widens intervals.
- **Label synthetic data** in code, API responses and UI. Real = OSM/Open-Meteo/real GTFS; synthetic = traffic, incidents, live transit status, closures, cab availability.
- The system must work **fully offline from cache**, and must not crash on missing/invalid data.
- Every recommendation shows **why** and **how sure**.
- Respect data licences: credit OpenStreetMap contributors and Open-Meteo in the UI footer.
- Keep the public APIs' fair-use limits; cache aggressively; no live Overpass calls during the demo.

Start now: read this spec, create `ASSUMPTIONS.md`, scaffold the repo (Phase 1), and proceed phase by phase, running tests and the app after each phase.

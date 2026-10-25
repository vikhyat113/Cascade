# Demo script (5 minutes)

**Setup (before the judges arrive)**
1. `cd frontend && npm run build` (once), then `cd backend && .venv/Scripts/python -m uvicorn app.main:app --port 8000`.
2. Open http://localhost:8000 in Chrome, full screen. In **Simulation**, click **⟲ Reset simulation**. The clock now reads **02:00, paused**; it starts by itself when you plan the first trip.
3. Keep a second tab on http://localhost:8000/scenarios with results already run (click **Run all scenarios** once, ~25 s).
4. Backup: if anything breaks, play `docs/demo/nightway_demo.webm` (automated walkthrough).

> **Pacing rule:** the clock runs at ×10 once a trip is planned. Press **⏸ Pause** right after step 1 and move time only with **+5 min / +15 min**. Data only ages when time moves, so each click is a visible "time passes" beat.

---

### 1. The request (45 s)
* The text box already says *"I finish at 2:15 AM and need to reach home by 3:00 AM"*. Click **Parse & plan**, then **⏸ Pause**.
* **Say:** "Three options, all as **ranges**: arrival 02:23–02:41, safety 68–84. Every card checks the 03:00 deadline in the best, expected and worst case."
* Point at the recommended cab card: **Data PROBABLE, limited by cab availability**, plus the explanation and the leave-time advice (*"Leave by 02:42 to arrive by 03:00 even in the worst case"*).
* The N1 bus card is **Plan B**, with *"N1 02:34: realtime KNOWN"*. The walking card is shown as an alternative with honest warnings (*"May miss your deadline"*, *"Walks 3.6 km, more than your limit"*).
* Hover the green route on the map: each segment lists its facts with badges and sources.

### 2. Data Trust panel (45 s)
* Right column: each source shows **REAL** or **SYNTHETIC**, its age, reliability, TTL and a status strip.
* Opening hours bar: about half of places are **UNKNOWN**. "We don't guess. A pharmacy without listed hours is UNKNOWN, not open." Hover a hollow grey dot on the map to show *hours unknown*.
* Lighting bar: OSM has lighting data on 2.5 % of streets; the rest is a **main-road prior** or **UNKNOWN**, and that widens the safety range rather than pretending.

### 3. Kill traffic + bus realtime (45 s)
* Simulation → **Kill traffic + bus realtime**, then **+5 min**, then **+5 min** again.
* Watch: the trust toggles turn red; sources go **KNOWN → PROBABLE → OUTDATED** ("no update for 6 min").
* Change log: *"Traffic speeds KNOWN → OUTDATED"*. The cab card now says **OUTDATED, limited by traffic speeds**. The bus timing falls back to the **timetable (PROBABLE)**, and the Plan B card says when to switch.

### 4. Kill ALL live data (40 s)
* **Kill ALL live data**, then **+15 min**.
* "Every feed is dead. We still produce a plan, from cached map data, the timetable and priors. Confidence drops (see the chart in the change log), statuses reach **UNKNOWN**, and the ranges get wider. Nothing is invented."
* Expand a card → *What this plan depends on* → traffic **UNKNOWN** with *0 % live*, and the ride shown as a range.

### 5. Rain and a road closure (45 s)
* **Restore everything**, then **🌧 Heavy rain**, then **⛔ Close main road on my route**, then **+5 min**.
* Change log: *"[truth] rain started: heavy"*, then the weather observation picks it up. *"Current plan broke (cab route crosses a closure (Amaltash Marg)); switched to …"*. A red closure marker appears on the map.
* "The simulator's ground truth is hidden from the planner. It only learns through feeds, so with the feeds dead it couldn't have known." Mention hysteresis: small improvements are logged as *"Kept current plan … below the hysteresis threshold"*.

### 6. Need it now: pharmacy (30 s)
* Left column → **💊 Pharmacy**.
* The nearest pharmacies are **UNKNOWN, hours unknown**, with *"Not assumed open: call ahead"*. The **Safer bet** is a hospital **PROBABLE open 24/7** with a safety-weighted walking route (cyan on the map).

### 7. Stress harness (30 s)
* Switch to the `/scenarios` tab: 8 scenarios replayed deterministically, **8/8 pass, 0 invalid outputs**. Every output was validated: an UNKNOWN fact never carried a value, ranges were ordered, and UNKNOWN critical data widened the output.
* Open **Details** on *Total live-data loss*: confidence 38 % → 0 %, the plan was never lost.

### If there is time
* **Heatmap** toggle and hour slider (22:00 → 05:00): safety by hour from the synthetic incident history and what is open at that hour.
* **I am a… → Nurse** for a different shift and home. On a phone, the layout switches to tabs.
* **SOS** (simulated): who would be notified, plus the nearest hospital and police with open-state badges.

### Answers to likely questions
* *Is the data real?* The street network, POIs, opening hours, lamps and the weather forecast are real (OSM, Open-Meteo, cached). Traffic, bus timetable and realtime, closures, cab availability and incidents are **synthetic**, and labelled so in the API and UI.
* *Why trust the safety score?* It is always a **range**, and the card shows what it depends on and how sure each input is. Worst-case safety drives the ranking.
* *Does it need the internet?* No. Map tiles are optional (Offline mode hides them), and everything else runs from the `data/` cache.

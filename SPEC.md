# ONE PROMPT: NightWay Android app (existing repo, full build, add-on mode)

> How to use: open a terminal in your clone of `git@github.com:vikhyat113/Cascade.git`, save this file in the repo root as `SPEC.md`, start Claude Code, and say:
> **"Read SPEC.md completely and execute it from Phase 0. Don't stop between phases unless SPEC.md tells you to ask me. Keep PROGRESS.md updated."**
> This file replaces all earlier prompts.

## FILL THESE 3 LINES (only used if the repo has no demo area yet)
```
CITY_NAME = <<city name>>
CENTER_LAT = <<latitude>>
CENTER_LON = <<longitude>>
```

---

## 0. Who you are working for, and the limits

You are the lead engineer for a 3-person hackathon team (CASCADE '26, problem 1.1 "The City That Sleeps While You Work"). The team knows web dev only. **They have under 8 hours total.** The deliverable is a **sideloadable Android APK** (debug build is fine). Android only. A real Android phone is connected by USB.

Rules:
- **Work inside the existing repo.** It already contains some files. Do not delete anything: move replaced code to `legacy/` and note it in `AUDIT.md`.
- Work on a new branch `nightway-android`. Commit after every phase and tag `phase-N`. **Do not push** unless I ask. Never rewrite history.
- Keep the app buildable at all times. If a feature blocks you, stub it behind an interface, note it in `PROGRESS.md`, and move on.
- Never put secrets in code. Never invent data (see section 4). Label synthetic data.
- Ask me a question only when you need a GUI click, an admin password, a decision that would delete work, or when SPEC.md says "ASK". Otherwise decide, write the assumption in `ASSUMPTIONS.md`, and continue.
- If your context gets long, write the current state and next steps to `PROGRESS.md` so work can resume.

---

## 1. The problem (what judges score)

Build a **Night-Time Decision Engine** for people who work at night. It must consider transport availability, operating hours of essential services, route safety and incident history, weather and road closures, shift timing, emergency facilities, and real-time changes with unreliable or incomplete data. Example: "I finish at 2:15 AM and need home by 3:00 AM." It must produce and **continuously update the safest feasible plan**, **keep working when live data is unavailable**, and **distinguish KNOWN → PROBABLE → OUTDATED → UNKNOWN instead of confidently inventing information.** This is the heart of the judging.

Users: ordinary night-shift workers (guards, nurses, factory, delivery, call-centre). Tired, in the dark, cheap phones, mixed English/Hindi. So the UI must be **simple, quiet and fast**.

---

## 2. Phase 0: environment and repo audit (do this first)

**2.1 Environment.** Detect the OS. Check for: git, Node.js (LTS), npm, JDK 17, Python 3 + pip, Android SDK (platform 34 or newer, build-tools, platform-tools/adb), `ANDROID_HOME`. Install anything missing using the system package manager (Homebrew on macOS, winget on Windows, apt on Linux) and the Android command-line tools (`sdkmanager`, accept licenses). Prefer no sudo. If a step needs a GUI click or an admin password, tell me exactly what to do and wait. Install Python packages with pip: `osmnx shapely requests`. Write the results to `ENVIRONMENT.md` (versions, paths, what you installed).

**2.2 Phone.** Run `adb devices`. If the phone shows `unauthorized`, ask me to accept the USB debugging prompt on the phone and wait. Record the device model and Android version in `ENVIRONMENT.md`. Also run `adb reverse tcp:8787 tcp:8787` later when the dispatch server runs, so the phone can reach the laptop over USB.

**2.3 Repo audit.** Read the README, package files, folder structure and any existing frontend/backend. Write `AUDIT.md`: what exists, what works, what you will **reuse**, what you will **refactor**, what you will **replace** (moved to `legacy/`). Then continue without waiting for approval unless the plan would discard working features, in which case ASK.

---

## 3. Stack (use this unless the repo already uses something better; justify in AUDIT.md)

- **App:** Capacitor + React + Vite + TypeScript + Tailwind. Map: Leaflet with canvas renderer. Tests: Vitest.
- **The phone does the thinking.** Planner, freshness engine, simulators and safety scoring run **inside the app in TypeScript** on data bundled in the APK. The app must work with **no internet**.
- **Build-time data tools:** Python (`tools/`), laptop only.
- **Demo dispatch server:** one small Node + Express file (`server/`), runs on the laptop.
- **Real Bluetooth:** a small Kotlin Capacitor plugin (Phase 7 only).
- No LLM and no API keys in the app. Natural-language input is a small rule-based parser.

---

## 4. Hard rules about data

- **Real:** OpenStreetMap streets and places (via OSMnx/Overpass, cached at build time), Open-Meteo weather (live when online, snapshot offline), real GTFS only if the city has an open feed.
- **Synthetic (flag `synthetic: true` in code; show "simulated" only inside the Demo drawer):** traffic, live bus status, road closures, incident history, cab/auto availability, hand-made bus schedules.
- **Never invent a value for UNKNOWN.** Unknown widens the result range and triggers a warning or Backup.
- Respect fair use of public APIs (identifying User-Agent, >= 1 s between requests, retries, cache). The app makes no calls to Overpass at runtime. Credit OpenStreetMap contributors and Open-Meteo in an About screen.

---

## 5. Product (screens)

1. **Home:** "Where to?" sheet over a dark map. From (auto "My location"), To (with **Home / Work** quick buttons), When (Now / time picker), Be there by (optional), big button **Find a safe way**. A row of four round buttons: **Medicine, Food, Hospital, Police**. Small pill **Live** / **Offline**. Small quiet **Demo** button (bottom-left).
2. **Result:** one way on the map. Tabs **Safest** (default) / **Balanced** / **Fastest**. Big line "Home by 2:58". Then **On time / Could be late / Too late**. Then **Safe / OK / Be careful** + one-line reason. Then icon steps (walk 6 min, bus 14 (8 min), walk 4 min). Only if something is not sure: one small line ("Bus time is a guess.") + **Backup** button. Big **Start**. Link **Places on the way**.
3. **Trip:** huge next step ("Walk 200 m to Gandhi Chowk stop"), "Home by 2:58", thin progress bar, always-visible red **Help** button, one banner at a time for changes ("Road ahead is closed. New way found." + **See**).
4. **Open now:** from the four round buttons. Up to 5 places: name, distance, minutes, **Open / Maybe open / Not sure**. Tap for a way.
5. **Help (SOS):** section 9.

### UI rules (strict)
- Phone first (360x740). One main thing per screen; one primary button.
- Buttons 1-3 words; lines max 8 words; explanations max 12 words; max ~25 words visible per screen. Write for a 12-year-old.
- Dark theme, one accent colour, text >= 16px, key text >= 24px, targets >= 48px. Icon + word + colour together.
- Status words (only when something is not sure **and** it changes the plan): PROBABLE = **Likely**, OUTDATED = **Old info**, UNKNOWN = **Not sure**, KNOWN = nothing shown.
- One banner at a time; no sounds, no flashing.
- **Banned in normal UI:** ETA, feasible, confidence, probability, route, fallback, contingency, latency, stale, TTL, freshness, data source, feed, API, synthetic, simulated, interval, range, worst case, algorithm, model, engine, degraded, unreliable. Use "Home by", "on time", "sure/likely", "way", "Backup", "old info", "maybe".
- Words only in `src/copy/en.ts` and `src/copy/hi.ts` (Hindi) with a small EN | हिं switch. Colours/spacing/type only in `src/theme.ts`. Thresholds and weights only in `src/config.ts`. **A test fails the build if any string breaks the banned-word or length rules.**
- Map: dark, no downloaded tiles. Draw the bundled road network as a faint line layer (major roads brighter), one route line, start dot, destination pin, user dot. POI icons only in "Places on the way" / "Open now".

---

## 6. Data bundled in the APK (`tools/build_data.py`, `npm run data`)

Reads the area from the repo if it already defines one, else the 3 lines above. Writes to `src/data/`:
- `graph.json`: walkable graph, radius 2.5 km: nodes `[lat, lon]`; edges `{u, v, len, hw, lit (1/0/-1), lamps (within 15 m), name?, geom (simplified ~2 m)}`; a coarse grid index. Keep < 8 MB.
- `pois.json`: hospitals, clinics, pharmacies, police, fire stations, fuel, ATMs, 24h shops/food, bus stops, stations: type, name, lat, lon, `opening_hours` or null, `phone` or null.
- `weather.json`: Open-Meteo hourly snapshot with `fetched_at`.
- `incidents.json`: **synthetic**, seeded grid of hour-dependent incident density (22:00-06:00), biased by real proxies (isolated roads, no lit tag, far from open POIs). Reproducible.
- `schedule.json`: real GTFS if available, else a small hand-built night schedule on real bus stops (2-3 routes, night frequencies, last service), marked synthetic.
- **Fallback:** if any download fails, generate a small sample dataset so the app always runs; print what was real and what was synthetic.

---

## 7. Engine (TypeScript, all unit-tested)

### 7.1 Facts and freshness (`src/engine/freshness.ts`)
```ts
type Status = "KNOWN" | "PROBABLE" | "OUTDATED" | "UNKNOWN";
interface Fact { key: string; value: unknown; source: string; synthetic: boolean;
  observedAt: number; ttlS: number; reliability: number;
  kind: "observed" | "scheduled" | "inferred" | "prior"; }
```
- KNOWN: observed, age <= ttl, reliability >= 0.7.
- PROBABLE: scheduled/inferred/prior and plausible for the time, or observed with ttl < age <= 3*ttl (confidence decaying).
- OUTDATED: observed with age > 3*ttl, or contradicted by newer data. Keep the value, discount it.
- UNKNOWN: no usable fact. Never fill in a value.
- `confidence = reliability * exp(-age/ttl)` clipped by kind. `aggregate()` = weakest-link status + confidence product.
- One app clock `now()` that the Demo drawer can override ("Set to 2:15 AM", speed 1x/10x/60x). The demo may happen in daytime, so **all night logic uses this clock.**

### 7.2 Simulation (`src/engine/sim/`, seeded)
- Traffic: base speed per road class x hour-of-night curve (near free-flow at 2-3 AM) x small variance, plus scripted events (accident, closure, waterlogging when it rains).
- Live feed simulator with timestamps, random delay and dropouts. Sources: `traffic`, `transit_realtime`, `closures`, `weather`. Each can be switched off.
- Lighting: real tags where known, else a prior by road class marked PROBABLE/UNKNOWN with a wide interval.
- Transit: schedule gives PROBABLE waits; fresh simulated realtime gives KNOWN. Cab/auto availability: time-of-night model, PROBABLE.
- Scenarios in `src/scenarios/*.json` (deterministic): calm night, bus cancelled, main road closed, rain starts mid-trip, conflicting sources, **all live info lost**, offline start, place with unknown hours. A runner plus a results table.

### 7.3 Planner (`src/engine/planner.ts`)
- A* or Dijkstra with a binary heap on the walk graph, plus virtual board/alight edges at bus stops. Modes: walk, walk + bus + walk, cab (with availability wait), wait-at-safe-haven then go.
- Candidates: several risk weights (`cost = time + lambda * risk * length`, lambda in {0, 0.5, 1, 2, 4}), dedupe near-identical paths.
- Evaluate forward in time per segment (time-dependent speeds, closures, weather). Output arrival `{best, expected, worst}` and risk parts as intervals: lighting, incident risk (hour-aware), isolation (distance to nearest open place), traffic/closure exposure, weather exposure, emergency proximity. `safety = 100 * (1 - weighted risk)` as `[lo, hi]`.
- Select by **worst-case feasibility**; else best-case with a loud warning; else "Too late" with the closest option. Rank by robust safety (`lo`). Offer Safest / Balanced / Fastest and a **Backup** for the weakest dependency. Advice: "Leave 8 min earlier.", safe-haven stops.
- Re-plan on every clock tick, fact expiry, source outage, closure or weather change. Use **hysteresis**. Produce a technical change-log entry and a one-sentence plain banner.

### 7.4 Simple view (`src/engine/simpleView.ts`)
The UI renders only this. `safety_level` from worst-case score (>= 75 safe, 50-74 ok, < 50 careful; thresholds in config). `timing`: on_time / maybe_late (+ "Maybe 3:06") / too_late. `warning` only if the weakest fact is PROBABLE/OUTDATED/UNKNOWN and it changes the plan. `safety_reason` from templates using the top 2 real factors (<= 12 words). Test that output has no banned words and respects length limits.

---

## 8. Offline and live

- Pill **Live** when online and the weather probe succeeds, else **Offline** ("Offline: using saved info" on the trip screen). Everything must work offline from bundled data.
- Home/Work, language and last plan persist locally (Capacitor Preferences).
- GPS via `@capacitor/geolocation`; if unavailable, tap the map.
- Loading, empty and error states in plain words.

---

## 9. Help (SOS) and escalation ladder

**Help** opens three big buttons: **I'm in danger** (police), **I need a doctor** (hospital/clinic), **Not sure** (police, then hospital). Always visible: **Call 112** (`tel:`) and **Text my contact** (`sms:` prefilled with a location link; the user taps send).

Ladder (timeouts configurable; short in demo):
1. If the phone can reach the dispatch server, **send directly**.
2. Else send into the **mesh transport** (section 10).
3. Destination by type: police first; if no acknowledgement within N seconds, the next type (nearest hospital/clinic from bundled POIs; show name and distance; if the POI has a `phone`, offer to call it).
4. Plain statuses: **Sending…, Passed on, Help is aware, Not sure.** Acknowledgements flow back.

**Demo dispatch server** (`server/`, Node + Express, one file, port 8787): `POST /sos`, `GET /sos/:id`, `POST /sos/:id/ack`, plus a dashboard page with **Police**, **Hospital** and **Contact** views (live list via SSE, coordinates, an **Acknowledge** button). Enable `CapacitorHttp` so the app can call plain `http://` from the WebView; default URL `http://localhost:8787` (works over USB with `adb reverse tcp:8787 tcp:8787`); configurable in the Demo drawer. State clearly in README and the Demo drawer that police/hospital endpoints are **simulated**.

**Safety timer:** before a trip the user can turn on "Tell my contact if I'm late". A local notification at deadline + 10 min asks "Are you home?"; ignoring it posts a simulated alert to the dispatch server and offers the prefilled SMS.

---

## 10. Mesh transport

```ts
interface MeshTransport { broadcast(p: SosPacket): void; onReceive(cb: (p: SosPacket) => void): void;
  status(): { peers: number; mode: "simulated" | "ble" }; }
type SosPacket = { id: number; type: "danger"|"medical"|"unsure"|"ack"; lat: number; lon: number; ts: number; hop: number; ttl: number; };
```
- **`SimulatedMeshTransport` (default, built in Phase 4):** ~6 virtual phones with gossip forwarding, dedupe by id, hop limit, store-and-forward until a "gateway" node has signal, which posts to the dispatch server. Shown **only in the Demo drawer** as an animated node graph labelled "simulated".
- **`BleMeshTransport` (Phase 7, real Bluetooth, behind a flag `MESH_REAL`, default OFF until verified).**

---

## 11. Demo drawer (hidden behind a small **Demo** button; lazy-loaded)

In order: **Break things** (toggles: Traffic info, Bus info, Weather info, **All live info**) / **Make it happen** (Rain starts, Road closed, Bus cancelled, Accident) / **Time** (Set to 2:15 AM, speed 1x/10x/60x) / **Scenarios** (list, Run, results table) / **Data check** (every source with official status Known / Probable / Outdated / Unknown, age, "simulated" tag) / **Change log** / **Mesh** (simulated graph, and real BLE status if enabled) / **Dispatch server URL** / **Real Bluetooth on/off**. Toggling anything makes the normal screens react naturally in plain words. A flag `VITE_SHOW_DEMO` controls whether the button shows.

---

## 12. Phases (time-boxed; each ends runnable; commit + tag)

- **Phase 0 (45-60 min):** environment, phone, repo audit (section 2).
- **Phase 1 (30 min):** Capacitor set up on the branch, hello-world APK installed on the phone via `adb install -r`. Provide `scripts/build-apk.sh` (`npm run build && npx cap sync android && cd android && ./gradlew assembleDebug`, then print the path `android/app/build/outputs/apk/debug/app-debug.apk`), `npm run dev`, and `npm run live` (Capacitor live reload on the phone). **Do not continue until the APK runs on the phone.**
- **Phase 2 (1.5 h):** data build, freshness engine, clock, simulators, planner, simple view, copy tests. All unit-tested.
- **Phase 3 (1.25 h):** Home → Result → Trip → Open now, pill, saved places, Hindi.
- **Phase 4 (1 h):** Help, ladder, dispatch server and dashboard, safety timer, simulated mesh.
- **Phase 5 (45 min):** Demo drawer and scenarios.
- **Phase 6 (45 min):** polish, 360px check, large-font check, accessibility labels, README, `DEMO.md`, final APK. **Feature freeze after this phase** (except add-on requests and bug fixes).
- **Phase 7 (time-box: 2 hours maximum, only after Phase 6 is tagged and the APK is safe):** real Bluetooth relay (section 13).

---

## 13. Phase 7: real Bluetooth relay (honest scope)

Context: bitchat is an **app**, not an SDK. Its Android code (permissionlesstech/bitchat-android) is a full Kotlin app with a BLE mesh. Do **not** try to embed it. Study it only for BLE permission handling, foreground-service patterns and mesh design, and respect its LICENSE. Build a **minimal, clean SOS-only relay** as a Capacitor plugin in Kotlin (`android/.../MeshPlugin.kt`) that implements `BleMeshTransport`.

Design:
- **Packets over BLE advertisements:** non-connectable legacy advertising with manufacturer-specific data (test company ID 0xFFFF). Payload <= ~24 bytes: `id (4B), type+ttl+hop (1-2B), lat (int32 microdegrees), lon (int32), ts (4B seconds)`. No signature in v1 (it does not fit); say so in docs and the Demo drawer.
- **Scan** with a filter for the company ID; **dedupe** by `id` (keep a short-lived cache); **rebroadcast** with `hop+1` after a short random jitter while `hop < ttl` (default ttl 5); rotate through queued packets so only a few are advertised at a time; stop advertising a packet after a time limit.
- **Gateway:** when the app has reachability to the dispatch server, forward received SOS packets to `POST /sos` and broadcast the returned acknowledgement as an `ack` packet.
- **Permissions:** Android 12+: `BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`; Android 11 and older: `BLUETOOTH`, `BLUETOOTH_ADMIN`, fine location. A **foreground service** (type connectedDevice) with a notification while the mesh is on. Request permissions in a plain-words screen.
- **Expose** `start()`, `stop()`, `broadcast(packet)`, and a `packet` event to the TypeScript side. The Demo drawer shows peers seen, packets relayed, last packet time.
- **Fail safe:** if the plugin or Bluetooth is unavailable, fall back to `SimulatedMeshTransport` automatically. The plugin must never break the APK build or the other features.
- **Time-box and checkpoint:** if two real phones cannot exchange a packet within the first 90 minutes of this phase, set `MESH_REAL` to OFF, keep the simulated transport as default, document findings in `docs/BLE_STATUS.md`, and stop. Multi-hop (3 phones) can only be verified when 3 Android phones are available: say clearly in `docs/BLE_STATUS.md` what was and was not verified. Never claim multi-hop works unless it was tested.
- Honest limits to document: only helps if other phones nearby run the app; range is short; battery and phone-brand background limits; Android advertising limits; police/hospital endpoints are simulated.

---

## 14. Quality gates (before calling any phase done)

- `npm test` passes (freshness, planner, simple view, copy rules).
- APK installs on the connected phone; a plan appears in <= 3 taps.
- **Airplane mode:** the app still finds a way and shows "Offline: using saved info".
- Demo drawer → "All live info" off: a plan still appears, warning in plain words, nothing invented.
- Demo clock set to 2:15 AM works in daytime.
- No normal screen shows a banned word, a status label on a sure fact, or technical numbers other than times, minutes and metres.
- Works at 360px width, with large system font, and with Hindi selected.

---

## 15. ADD-ON MODE (after the build, for ideas I send later)

For every later request (frontend ideas, extra features):
1. Restate it in one line and say which layer it touches (copy, theme, config, a screen component, engine, server, plugin).
2. If it breaks a UI rule (too many words, banned words, clutter), tell me kindly, propose the simplest version that keeps the rule, and do that unless I insist.
3. Make the smallest change in the right layer. Words in `copy/`, look in `theme.ts`, numbers in `config.ts`. UI components never hard-code text, colours or thresholds; engine code never imports UI code.
4. Run `npm test`. For visual changes, tell me to check `npm run dev` in Chrome; rebuild and install the APK only when real-phone behaviour is involved.
5. Log it in `CHANGES.md`, commit, and tag stable states (`stable-1`, `stable-2`). Keep the branch always buildable.
6. After Phase 6, new features are allowed only if they don't touch the offline mode, the four statuses or the Demo drawer toggles unless I say so.

---

## 16. Final output

At the end of each phase, update `PROGRESS.md` with: what is done, what is next, what is broken or unverified, and exact commands to run, build and demo. At the end, print: the APK path, how to run the dispatch server, how to start the demo, and a short list of what is real vs simulated.

Start now: read this file, begin Phase 0, and continue phase by phase.

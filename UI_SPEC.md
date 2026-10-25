# MASTER PROMPT — Simple UI for "NightWay" (replaces the frontend parts of SPEC.md)

> Give this file to Claude Code together with `SPEC.md`. Say: "Read SPEC.md and this file. Where they disagree about the user interface, THIS FILE WINS. The backend logic in SPEC.md stays. If a frontend already exists, refactor it. If not, build it."

---

## 0. What changes, in one paragraph

The app is for **ordinary night-shift workers**, not engineers. They are tired, may be walking in the dark, may use a cheap phone, and may not read English well. So the screen must be **simple, quiet and fast**. One question per screen. Big buttons. Very few words. Easy words. All the smart stuff (freshness engine, trust board, scenarios, logs) stays in the backend and moves into a hidden **Demo** drawer for judges. Normal users never see it.

Keep: live updates, offline mode, Plan B, need-now finder, safety scoring, the four data statuses (internally).
Remove from the normal screen: Data Trust panel, change log, heatmap, persona presets, risk slider, score breakdowns, ranges with many numbers, source names, "synthetic" tags, timeline bar, layer toggles.

---

## 1. Design rules (follow strictly)

1. **Phone first.** Design at 360×740. Desktop is just the same screen, centred, max width ~480px with the map filling the rest.
2. **One main thing per screen.** Never more than one primary button.
3. **Few words.** Buttons: 1–3 words. Lines of text: max 8 words. Explanations: max 12 words, one line. Max ~25 words visible on any screen.
4. **Easy words only** (see copy deck and banned list below). Write for a 12-year-old.
5. **Show detail only when it matters.** Do not show a status label on things that are fine. Show it only when something is *not sure*.
6. **Icons + words + colour** together (never colour alone).
7. **Big and clear.** Body text ≥ 16px, key text ≥ 24px, tap targets ≥ 48px, high contrast, dark night theme with one accent colour. No tiny grey text.
8. **Calm.** No pop-up spam, no flashing, no sounds. At most one banner at a time.
9. **Fast.** First screen usable in under 2 seconds; works offline from cache; Demo drawer is code-split and loaded only when opened.
10. **Words live in one file** (`frontend/src/copy/en.ts`) so they can be translated. Add `hi.ts` (Hindi) with a small language switch (EN | हिं). Add Marathi later if time allows.

---

## 2. The three screens

### Screen 1 — Home ("Where to?")
Full-screen map behind a bottom sheet.
- Top: tiny status pill: **Live** (green dot) or **Offline** (grey dot). Nothing else at the top.
- Sheet contents, in this order:
  1. Field: **"From"** (pre-filled "My location"; tap to change)
  2. Field: **"To"** with two quick buttons under it: **Home** · **Work** (user can save them once)
  3. Two chips: **When: Now** (tap for time picker) and **Be there by: –** (optional time)
  4. Big button: **Find a safe way**
  5. A single row of four round icon buttons: **Medicine · Food · Hospital · Police**. Tapping one opens "Open now" (Screen 4 below).
- Bottom-left, small and quiet: a **Demo** button (see section 5). Shown only if `VITE_SHOW_DEMO=true`.

### Screen 2 — Result ("Your way")
Map shows ONE route line, start dot, end pin. Bottom sheet shows:
1. Three small tabs: **Safest** (default) · **Balanced** · **Fastest**
2. Big line: **"Home by 2:58"** (use the destination name if not Home: "At Station by 2:58"). Under it, ONE of:
   - ✅ **On time** (if even the slow case meets the deadline)
   - ⚠️ **Could be late** + small text "Maybe 3:06" (if only the fast case meets it)
   - ❌ **Too late** (if no way meets it) — then also show the closest option and a **Backup** button
3. **Safety** with three levels, big icon + word: 🟢 **Safe** · 🟡 **OK** · 🔴 **Be careful**. One short reason line: e.g. "Lit roads, shops open on the way."
4. **Steps** as icons with minutes: 🚶 6 min → 🚌 14 (8 min) → 🚶 4 min. Nothing more.
5. Only if something is **not sure**, ONE small yellow line: e.g. "Bus time is a guess." with a **Backup** button.
6. Big button: **Start**
7. Small text link: **Places on the way** (collapsed; opens a list: open pharmacy, hospital, police with distance). Map shows these icons only when opened.

### Screen 3 — Trip ("Go")
- Huge next step: **"Walk 200 m to Gandhi Chowk stop"** with an arrow/mini map.
- Big: **"Home by 2:58"** and a thin progress bar.
- Always-visible red button: **Help** → opens: **Call 112**, **Nearest hospital**, **Nearest police** (with simple route). Add **Share trip** (copy link; simulated).
- If the plan changes: a single banner at top, e.g. **"Road ahead is closed. New way found."** with a **See** button. Auto-hide after 8 seconds. Never more than one.
- If connection drops: the pill changes to **Offline**; the trip continues from saved info. Nothing else changes.

### Screen 4 — Open now (from the four icon buttons)
List of up to 5 places: name, distance, walking minutes, and a state word: **Open** · **Maybe open** · **Not sure**. Tap → route (goes to Screen 2). Nothing else.

---

## 3. Words: copy deck, status words, banned words

### Status words (internal enum stays KNOWN / PROBABLE / OUTDATED / UNKNOWN; the UI uses these)
| Internal | User sees | Icon | When shown |
|---|---|---|---|
| KNOWN | (nothing) | – | Never shown on normal screens |
| PROBABLE | **Likely** | ~ | Only when it affects the plan |
| OUTDATED | **Old info** | clock | Only when it affects the plan |
| UNKNOWN | **Not sure** | ? | Only when it affects the plan |

(In the Demo drawer, show the official names too: Known / Probable / Outdated / Unknown, so judges can map them.)

### Key strings (put in `en.ts`; write Hindi equivalents in `hi.ts`)
- Find a safe way · From · To · Home · Work · Now · Be there by · Start · Backup · Help
- Safest · Balanced · Fastest
- On time · Could be late · Too late
- Safe · OK · Be careful
- Live · Offline · Offline: using saved info
- Open · Maybe open · Not sure · Likely · Old info
- "Bus time is a guess." · "Road ahead is closed. New way found." · "No bus now. Try a cab." · "No signal. Using saved info."

### Banned words (never in the normal UI): replace as shown
ETA → "Home by" / "Arrive by" · feasible → "on time" · confidence/probability → "sure / likely" · route → "way" · fallback/contingency → "Backup" · latency/stale/TTL/freshness → "old info" · data source/feed/API → (do not mention) · synthetic/simulated → (only in Demo drawer) · interval/range/worst case → "maybe" · algorithm/model/engine → (do not mention) · ambiguous/unreliable/degraded → "not sure"

**Enforce it:** add a unit test that scans every string in `en.ts` for banned words and for length limits (labels ≤ 3 words, lines ≤ 8 words, explanations ≤ 12 words) and fails the build if broken.

---

## 4. Backend change: a "simple view" for the UI

Do **not** make the frontend compute or translate anything technical. Add `backend/app/presentation/simple_view.py` and return this in `POST /api/plan` and the SSE stream:

```json
{
  "options": [
    {
      "id": "safest",
      "label": "Safest",
      "arrive_text": "Home by 2:58",
      "timing": "on_time",            // on_time | maybe_late | too_late
      "late_text": null,               // e.g. "Maybe 3:06"
      "safety_level": "safe",          // safe | ok | careful
      "safety_reason": "Lit roads, shops open on the way.",
      "steps": [{"icon":"walk","minutes":6,"text":"Walk 200 m to Gandhi Chowk stop"}, {"icon":"bus","line":"14","minutes":8}],
      "warning": {"text":"Bus time is a guess.","pill":"Likely","backup_option_id":"cab"},
      "places": [{"type":"pharmacy","name":"...","distance_m":120,"state":"open"}]
    }
  ],
  "banner": {"text":"Road ahead is closed. New way found.","see_option_id":"safest"},
  "connection": "live"                 // live | offline
}
```
Rules for the mapping (keep them in one place, with tests):
- `safety_level` comes from the **worst-case** safety score: ≥ 75 safe, 50–74 ok, < 50 careful (thresholds in `config.yaml`). If the data is mostly UNKNOWN, show the level but add a warning "Not sure about lights."
- `timing` comes from deadline vs best/expected/worst arrival.
- `warning` appears only if the **weakest fact** is PROBABLE / OUTDATED / UNKNOWN **and** it changes the plan. Otherwise `null`.
- `safety_reason` is built from the top 2 real factors (templates, not free LLM text). If an LLM is used, it only rephrases a template and must stay ≤ 12 words; fall back to the template on any failure.
- `banner` is created from the change log: take the newest meaningful change and convert it to one plain sentence; the full technical log stays available in the Demo drawer.
- The simple view must contain **no** banned words (test it).

The full technical output (ranges, breakdowns, statuses) is still returned under `details` for the Demo drawer. Do not delete it.

---

## 5. Hidden Demo drawer (for judges and testing)

- A small, quiet **Demo** button (bottom-left). Tapping it slides up a drawer. Closed by default. Lazy-loaded.
- Inside, in this order:
  1. **Break things** (big toggles): Traffic info · Bus info · Weather info · **All live info** (each ON/OFF)
  2. **Make it happen** (buttons): Rain starts · Road closed · Bus cancelled · Accident
  3. **Time**: clock speed (1×, 10×, 60×) and a time field
  4. **Scenarios**: list, **Run**, and a **Results** table (from the stress harness)
  5. **Data check**: every source with its official status (Known / Probable / Outdated / Unknown), age, and a "simulated" tag
  6. **Change log**: full technical entries
- Everything the main screens do must still work with the drawer closed. When a toggle is flipped in the drawer, the user-facing screen reacts normally (pill turns Offline, banner appears, Backup shows up), so the demo looks natural.

---

## 6. Map rules
- Dark, clean base map. One route line (accent colour), start dot, destination pin, user location dot.
- No streetlight layers, heatmaps, risk colours, or marker clutter by default.
- Show POI icons only inside "Places on the way" or "Open now".
- Respect OpenStreetMap attribution (small, in the corner).

---

## 7. Build steps
1. Create `copy/en.ts`, `copy/hi.ts`, the banned-words test, and the theme (colours, type scale, spacing).
2. Build `simple_view.py` + tests (use a fixture plan).
3. Build Home → Result → Trip → Open now, using the simple view only.
4. Connect live updates (banner, pill) and offline behaviour (service worker caches app shell; API falls back to cached plans/POIs/graph results; pill shows Offline).
5. Build the Demo drawer last, wired to the existing simulation endpoints.
6. Polish: loading states ("Finding a safe way…"), empty states, error states in plain words ("Can't find a way. Try another place."), accessibility labels, 360px check.

## 8. Acceptance checks (run before calling it done)
- A new person gets a route in **3 taps or fewer** (From is auto-filled → type To → Find a safe way).
- No normal screen shows more than ~25 words, any banned word, a status label on a sure fact, or any technical number other than times, minutes and metres.
- Turn on airplane mode: the app still finds a way and shows **Offline: using saved info**.
- Flip "All live info" off in Demo: a plan still appears, the pill/warning appear in plain words, nothing is invented.
- Works at 360px width, with large system font size, and with Hindi selected.
- Lighthouse performance ≥ 80 on mobile profile, and the Demo drawer code is not in the initial bundle.

## 9. New demo script (replace the old one)
1. Open on a phone-size screen. Type "Home". Tap **Find a safe way**. Show the result: "Home by 2:58 · On time · Safe."
2. Tap **Start**. Show the trip screen and the **Help** button.
3. Open **Demo** → switch off **Bus info**. The screen shows "Bus time is a guess." + **Backup**. Tap Backup.
4. Switch off **All live info**. The pill says **Offline**; a plan still appears.
5. Tap **Road closed**. The banner says "Road ahead is closed. New way found."
6. Open **Data check** and **Results** to show the official four statuses and the stress tests.
7. Tap **Medicine** to show the open-now list with "Open / Maybe open / Not sure".

Start by reading SPEC.md and this file, list any conflicts and how you resolved them in `ASSUMPTIONS.md`, then build in the order above.

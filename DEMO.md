# NightWay demo script (about 3 minutes)

## Before you start (5 min)

1. **Laptop**: `cd server && npm start`. Note the Wi-Fi address it prints, e.g. `http://192.168.1.20:8787`, and open the dashboard http://localhost:8787 (Police tab) on the laptop screen. Allow Node through the firewall if Windows asks.
2. **Phone**: same Wi-Fi as the laptop. Open NightWay → **Demo** (bottom left) → **8. Dispatch server**, enter the address → **Save + test**. It should say "reachable". Close the drawer.
3. If a trip is still running from rehearsal, tap **End trip**.
4. Optional: screen-mirror the phone (e.g. scrcpy, or the phone's cast feature).

## The story

**1. The problem (20 s)**
"Priya finishes her shift at 2:15 AM in Noida and must be home by 3:00. The metro is closed. Which way is safe, and will she make it?"

**2. Plan in three taps (30 s)**
- Demo → **3. Time → Set to 2:15 AM** → Close. (The demo works in the daytime; all night logic uses the app's clock.)
- Tap **Home**, then **Find a safe way**.
- Point out: "Home by 2:29", **On time**, **Safe** + one reason, the steps. Tabs Safest / Balanced / Fastest. No jargon on the screen.
- Switch on **Tell my contact if I'm late**, then tap **Start**.

**3. The city changes (45 s)**
- Demo → **2. Make it happen → Road closed** → Close. A banner appears: *"Road ahead is closed. New way found."* Tap **See**.
- Demo → **1. Break things → Traffic info OFF**, then **3. Time → +5 min** twice. Explain: the app never pretends. When a source stops, its facts age Known → Probable → Outdated → Unknown, and the plan gets more careful: a one-line warning (*"Traffic info is old."*, or *"Bus time is a guess."* on a bus way) and a **Backup** button.
- Demo → **6. Change log** shows the technical reason for every change, for judges.

**4. No signal (30 s)**
- Turn on **airplane mode** on the phone (or Demo → **All live info OFF**, then **+5 min** three times).
- The pill says **"Offline: using saved info"**; the trip goes on; the warning says what is old. Nothing is invented. Everything runs on the phone.
- Turn airplane mode off again (needed for the Help demo).

**5. Help (40 s)**
- Tap the red **Help** → **I'm in danger**. Status: *Sending… → Passed on*.
- On the laptop dashboard the alert appears under **Police** with the location. Press **Acknowledge**; the phone shows **Help is aware**.
- Mention: with no answer in 20 s, the app asks the hospital next, and **Call 112** and **Text my contact** are always there.
- Optional: Demo → **7. Mesh → Help via mesh ON**, then Help → **Not sure**. Watch the request hop through the simulated phones to the gateway; acknowledge it on the dashboard (Police tab, "via mesh, 3 hops").

**6. Safety timer (15 s, optional)**
- Demo → **8 → Safety timer: ask now**. The phone asks *"Are you home?"*. Don't answer: 20 s later the **Contact** tab on the dashboard gets an alert and the phone offers the prefilled text.

**7. Proof (20 s)**
- Demo → **4. Scenarios → Run all scenarios**: 8/8 pass (bus cancelled, road closed, rain mid-trip, conflicting sources, all live info lost, offline start, unknown opening hours).
- Demo → **5. Data check**: every source with its official status and age, real or simulated.
- Switch to **हिं** to show Hindi.

## If something goes wrong

| Problem | Fix |
|---|---|
| "can't reach" in the drawer | Same Wi-Fi? Address typed with `http://` and `:8787`? Windows firewall allowing Node? Help still works through the simulated mesh and Call 112. |
| Plan says "Too late" | The app clock is past 3:00: Demo → Set to 2:15 AM. |
| Strange state after rehearsal | Demo → 3. Time → **Back to real time**, then End trip. |
| Pill stuck on Offline | Demo → 1 → switch the sources back ON, or turn airplane mode off and wait a few seconds. |

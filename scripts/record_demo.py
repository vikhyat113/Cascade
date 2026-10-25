"""Record the backup demo video (an automated walkthrough of DEMO.md with captions).

    pip install playwright            # once; uses your installed Chrome, no browser download
    python scripts/record_demo.py [--url http://localhost:8000]

Needs the backend running with the built frontend. Writes
docs/demo/nightway_demo.webm and refreshes docs/screenshots/*.png.
"""
from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "demo"
SHOTS = ROOT / "docs" / "screenshots"
URL = sys.argv[sys.argv.index("--url") + 1] if "--url" in sys.argv else "http://localhost:8000"
ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]

CAPTION_JS = """(t) => {
  let el = document.getElementById('demo-caption');
  if (!el) {
    el = document.createElement('div'); el.id = 'demo-caption';
    el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;max-width:900px;' +
      'background:rgba(139,92,246,.95);color:#fff;font:600 17px Inter,system-ui,sans-serif;padding:10px 18px;' +
      'border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.5);text-align:center;line-height:1.35';
    document.body.appendChild(el);
  }
  el.textContent = t;
}"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    SHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True, args=ARGS)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, record_video_dir=str(OUT),
                                  record_video_size={"width": 1440, "height": 900})
        page = ctx.new_page()
        cap = lambda t, s=3.0: (page.evaluate(CAPTION_JS, t), time.sleep(s))  # noqa: E731
        btn = lambda name: page.get_by_role("button", name=name).click()    # noqa: E731

        def snap(name: str) -> None:
            """Clean screenshot for the README: no caption, panels scrolled to the top."""
            page.evaluate("""() => { const c = document.getElementById('demo-caption'); if (c) c.style.display = 'none';
                document.querySelectorAll('.overflow-auto').forEach(e => e.scrollTop = 0); }""")
            time.sleep(0.4)
            page.screenshot(path=str(SHOTS / name))
            page.evaluate("() => { const c = document.getElementById('demo-caption'); if (c) c.style.display = ''; }")

        page.goto(URL)
        page.get_by_role("heading", name="Plan a night trip").wait_for(timeout=30000)
        btn("⟲ Reset simulation")
        time.sleep(2)
        cap("NightWay: a night-shift worker asks “I finish at 2:15 AM, need to reach home by 3:00 AM”", 4)
        btn("Parse & plan")
        page.get_by_text("Your options").wait_for(timeout=30000)
        btn("⏸ Pause")
        time.sleep(2)
        cap("Three options, all as ranges: arrival window, safety range, deadline check in best / expected / worst case", 5)
        snap("desktop.png")
        cap("Every fact carries a badge: KNOWN · PROBABLE · OUTDATED · UNKNOWN. Synthetic data is labelled", 4)
        page.get_by_text("Steps, data trust & risk breakdown").first.click()
        cap("Each step lists the facts it depends on, with source, age and confidence", 5)
        page.get_by_text("Hide details").first.click()
        cap("Data Trust panel: every source with status, age, reliability and an outage switch", 4)
        cap("Opening hours: about half of places have no listed hours. They are UNKNOWN, never guessed as open", 5)
        btn("Kill traffic + bus realtime")
        cap("Outage: live traffic and bus realtime stop. Watch them age…", 3)
        btn("+5 min")
        time.sleep(2)
        btn("+5 min")
        cap("KNOWN → PROBABLE → OUTDATED. The plan re-computes and the change log explains why", 6)
        btn("Kill ALL live data")
        btn("+15 min")
        cap("Every live feed dead: still a plan, from cache, timetable and priors. Confidence drops, ranges widen", 6)
        snap("all_live_dead.png")
        btn("Restore everything")
        btn("🌧 Heavy rain")
        btn("⛔ Close main road on my route")
        cap("Heavy rain and a road closure, injected into ground truth. The planner only learns via feeds", 3)
        btn("+5 min")
        cap("Closure detected: current route broke → re-planned (with hysteresis), reasons in the change log", 6)
        btn("💊 Pharmacy")
        cap("Need it now: pharmacies without listed hours are UNKNOWN (call ahead); safer bet: a probably-open hospital", 6)
        page.get_by_role("checkbox", name="heatmap").check()
        cap("Night safety heatmap by hour (synthetic incident history plus what is open at that hour)", 5)
        page.get_by_role("checkbox", name="heatmap").uncheck()
        page.goto(f"{URL}/scenarios")
        page.get_by_role("button", name="Run all scenarios").wait_for(timeout=20000)
        cap("Stress harness: 8 deterministic scenarios, every output validated", 2)
        btn("Run all scenarios")
        page.get_by_text("passing").wait_for(timeout=120000)
        cap("8/8 scenarios pass with 0 invalid outputs: no UNKNOWN fact ever carried a value", 6)
        snap("scenarios.png")
        video = page.video.path()
        ctx.close()
        m = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        m.goto(URL)
        m.get_by_role("heading", name="Plan a night trip").wait_for(timeout=30000)
        m.get_by_role("button", name="Parse & plan").click()
        m.get_by_text("Your options").wait_for(timeout=30000)
        time.sleep(2)
        m.screenshot(path=str(SHOTS / "mobile.png"))
        browser.close()
    final = OUT / "nightway_demo.webm"
    if final.exists():
        final.unlink()
    shutil.move(video, final)
    print(f"video: {final.relative_to(ROOT)} ({final.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()

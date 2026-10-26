// End-to-end: the SOS button is visible, 56 px, and on top on every screen, at 360 px, in English
// and Hindi. Needs a built app (`npm run build`) and Chrome or Edge.   npm run e2e
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const PORT = 4179, URL = `http://localhost:${PORT}/`;
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? "chrome", headless: true })
  .catch(() => chromium.launch({ channel: "msedge", headless: true }));
const fails = [];
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(URL)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
  for (const lang of ["en", "hi"]) {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const T = lang === "en"
      ? { find: "Find a safe way", start: "Start", home: /Home/, search: /To/, about: "About", close: "Close", demo: "Demo", med: /Medicine/ }
      : { find: "सुरक्षित रास्ता खोजें", start: /शुरू/, home: /घर/, search: /कहाँ तक/, about: "जानकारी", close: "बंद करें", demo: "डेमो", med: /दवा/ };
    const check = async (screen) => {
      const r = await page.evaluate(() => {
        const b = document.querySelector("[data-sos]");
        if (!b) return { missing: true };
        const box = b.getBoundingClientRect();
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { w: box.width, h: box.height, x: box.x, right: box.right, y: box.y, onTop: !!top && (top === b || b.contains(top)), label: b.getAttribute("aria-label"), text: b.textContent };
      });
      const bad = r.missing ? ["missing"] : [
        ...(r.h < 56 || r.w < 56 ? [`small ${Math.round(r.w)}x${Math.round(r.h)}`] : []),
        ...(r.right > 360 || r.y < 0 ? ["off screen"] : []),
        ...(!r.onTop ? ["covered"] : []),
        ...(!r.label ? ["no label"] : []),
      ];
      console.log(`${lang} ${screen.padEnd(14)} ${bad.length ? "FAIL " + bad.join(", ") : "ok"}`);
      if (bad.length) fails.push(`${lang} ${screen}: ${bad}`);
    };
    await page.goto(URL);
    await page.locator("[data-sos]").first().waitFor({ timeout: 10000 }).catch(() => {});
    await check("first screen");
    await page.getByRole("button", { name: "Find a safe way" }).waitFor({ timeout: 30000 });
    if (lang === "hi") await page.getByRole("button", { name: "हिं" }).click();
    await check("home");
    await page.getByRole("button", { name: T.about, exact: true }).click(); await check("about"); await page.getByRole("button", { name: T.close, exact: true }).click();
    await page.getByRole("button", { name: T.demo, exact: true }).click(); await check("demo drawer"); await page.getByRole("button", { name: "Close", exact: true }).first().click();
    await page.getByRole("button", { name: T.search }).first().click(); await check("search"); await page.keyboard.press("Escape");
    await page.goto(URL); await page.getByRole("button", { name: T.find }).waitFor();
    await page.getByRole("button", { name: T.med }).click(); await page.waitForTimeout(800); await check("open now");
    await page.goto(URL); await page.getByRole("button", { name: T.find }).waitFor();
    await page.getByRole("button", { name: T.home }).first().click();
    await page.getByRole("button", { name: T.find }).click();
    await page.getByRole("button", { name: T.start }).waitFor({ timeout: 30000 }); await check("result");
    await page.getByRole("button", { name: T.start }).click(); await page.waitForTimeout(600); await check("trip");
    await page.locator("[data-sos]").click(); await page.waitForTimeout(400); await check("help sheet");
    const callFirst = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      const first = d?.querySelector("a, button");
      return first?.getAttribute("href") === "tel:112";
    });
    console.log(`${lang} help sheet    Call 112 first: ${callFirst ? "ok" : "FAIL"}`);
    if (!callFirst) fails.push(`${lang}: Call 112 is not the first control in Help`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(fails.length ? `\n${fails.length} failure(s)` : "\nSOS ok on every screen");
process.exit(fails.length ? 1 : 0);

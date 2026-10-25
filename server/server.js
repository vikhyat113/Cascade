// NightWay demo dispatch server (spec §9). SIMULATED police / hospital / contact desks for the demo:
// nothing here reaches real emergency services. One file, in-memory, port 8787.
//
//   POST /sos            { id, type, to, lat, lon, ts, via, hops }  -> { id, ok }
//   GET  /sos/:id        -> { id, acked, ack, targets }
//   POST /sos/:id/ack    { to?, by? }                               -> { id, acked }
//   GET  /sos            -> all alerts            GET /events -> live list (SSE)
//   GET  /health         -> { ok }                GET /       -> dashboard (Police / Hospital / Contact)
import express from "express";
import os from "node:os";

const PORT = Number(process.env.PORT || 8787);
const TYPES = new Set(["danger", "medical", "unsure"]);
const DESKS = new Set(["police", "hospital", "contact"]);
const alerts = new Map();          // id -> alert
const clients = new Set();         // SSE responses

const app = express();
app.use(express.json({ limit: "16kb" }));
app.use((req, res, next) => {      // the app's WebView and `npm run dev` call from other origins
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "content-type");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function view(a) {
  const ack = a.targets.find((t) => t.ack) ?? null;
  return { ...a, acked: !!ack, ack: ack ? { to: ack.to, by: ack.ack.by, at: ack.ack.at } : null };
}
function broadcast() {
  const data = `data: ${JSON.stringify([...alerts.values()].map(view))}\n\n`;
  for (const res of clients) res.write(data);
}

app.get("/health", (_req, res) => res.json({ ok: true, simulated: true }));

app.post("/sos", (req, res) => {
  const b = req.body ?? {};
  const id = String(b.id ?? "").slice(0, 32);
  const lat = num(b.lat), lon = num(b.lon);
  if (!id || lat === null || lon === null || !TYPES.has(b.type) || !DESKS.has(b.to)) {
    return res.status(400).json({ error: "need id, type (danger|medical|unsure), to (police|hospital|contact), lat, lon" });
  }
  const now = Date.now();
  let a = alerts.get(id);
  if (!a) { a = { id, type: b.type, lat, lon, ts: num(b.ts) ?? now, receivedAt: now, targets: [] }; alerts.set(id, a); }
  a.lat = lat; a.lon = lon;
  let t = a.targets.find((x) => x.to === b.to);
  if (!t) { t = { to: b.to, at: now, via: b.via === "mesh" ? "mesh" : "direct", hops: num(b.hops) ?? 0, ack: null }; a.targets.push(t); }
  broadcast();
  res.json({ id, ok: true });
});

app.get("/sos", (_req, res) => res.json([...alerts.values()].map(view)));

app.get("/sos/:id", (req, res) => {
  const a = alerts.get(req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });
  res.json(view(a));
});

app.post("/sos/:id/ack", (req, res) => {
  const a = alerts.get(req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });
  const to = req.body?.to;
  const t = (DESKS.has(to) ? a.targets.find((x) => x.to === to) : null) ?? a.targets[a.targets.length - 1];
  if (t && !t.ack) t.ack = { by: String(req.body?.by ?? `${t.to} desk (simulated)`).slice(0, 60), at: Date.now() };
  broadcast();
  res.json({ id: a.id, acked: !!t?.ack });
});

app.get("/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  clients.add(res);
  res.write(`data: ${JSON.stringify([...alerts.values()].map(view))}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => { clearInterval(ping); clients.delete(res); });
});

app.get("/", (_req, res) => res.type("html").send(DASHBOARD));

const DASHBOARD = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NightWay dispatch (simulated)</title>
<style>
  :root { --bg:#0a0f1e; --card:#131b31; --edge:#2c3860; --ink:#f4f6ff; --soft:#c3cae6; --accent:#8b7cff; --bad:#f87171; --good:#34d399; --warn:#fbbf24; }
  * { box-sizing: border-box; } body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.4 system-ui, sans-serif; }
  header { padding:14px 18px; border-bottom:1px solid var(--edge); display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:20px; margin:0; } .sim { background:var(--warn); color:#000; font-weight:700; padding:3px 10px; border-radius:999px; font-size:13px; }
  nav { display:flex; gap:8px; padding:12px 18px; } nav button { background:var(--card); color:var(--ink); border:1px solid var(--edge); border-radius:12px; padding:10px 16px; font-size:16px; font-weight:600; cursor:pointer; }
  nav button[aria-pressed=true] { background:var(--accent); color:#0a0f1e; border-color:var(--accent); }
  main { padding:0 18px 24px; display:grid; gap:10px; } .empty { color:var(--soft); padding:20px 0; }
  .a { background:var(--card); border:1px solid var(--edge); border-radius:14px; padding:12px 14px; display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  .a.new { border-color:var(--bad); } .t { font-weight:700; font-size:18px; } .m { color:var(--soft); font-size:14px; } .grow { flex:1; min-width:220px; }
  .ack { background:var(--good); color:#000; border:0; border-radius:10px; padding:10px 16px; font-weight:700; font-size:16px; cursor:pointer; } .done { color:var(--good); font-weight:700; }
  a { color:var(--accent); }
</style></head><body>
<header><h1>NightWay dispatch</h1><span class="sim">SIMULATED · demo only · not real police or hospital</span><span class="m" id="st">connecting…</span></header>
<nav><button data-desk="police">Police</button><button data-desk="hospital">Hospital</button><button data-desk="contact">Contact</button></nav>
<main id="list"></main>
<script>
  const TYPE = { danger: "In danger", medical: "Needs a doctor", unsure: "Not sure" };
  let desk = location.hash.slice(1) || "police", data = [];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 90 ? s + " s ago" : Math.round(s / 60) + " min ago"; };
  function render() {
    document.querySelectorAll("nav button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.desk === desk));
    const rows = data.filter((a) => a.targets.some((t) => t.to === desk)).sort((a, b) => b.receivedAt - a.receivedAt);
    document.getElementById("list").innerHTML = rows.length ? rows.map((a) => {
      const t = a.targets.find((x) => x.to === desk);
      const map = "https://www.openstreetmap.org/?mlat=" + a.lat + "&mlon=" + a.lon + "#map=17/" + a.lat + "/" + a.lon;
      return '<div class="a ' + (t.ack ? "" : "new") + '"><div class="grow"><div class="t">' + esc(TYPE[a.type] || a.type) + '</div>' +
        '<div class="m">' + a.lat.toFixed(5) + ", " + a.lon.toFixed(5) + ' · <a href="' + map + '" target="_blank" rel="noopener">map</a> · ' + ago(t.at) +
        " · via " + esc(t.via) + (t.via === "mesh" ? " (" + t.hops + " hops)" : "") + " · id " + esc(a.id) + "</div></div>" +
        (t.ack ? '<span class="done">Acknowledged</span>' : '<button class="ack" data-id="' + esc(a.id) + '">Acknowledge</button>') + "</div>";
    }).join("") : '<p class="empty">No alerts for this desk yet.</p>';
  }
  document.querySelector("nav").onclick = (e) => { const d = e.target.dataset.desk; if (d) { desk = d; location.hash = d; render(); } };
  document.getElementById("list").onclick = (e) => {
    const id = e.target.dataset.id;
    if (id) fetch("/sos/" + encodeURIComponent(id) + "/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: desk }) });
  };
  const es = new EventSource("/events");
  es.onmessage = (e) => { data = JSON.parse(e.data); document.getElementById("st").textContent = "live"; render(); };
  es.onerror = () => { document.getElementById("st").textContent = "reconnecting…"; };
  setInterval(render, 10000);
  render();
</script></body></html>`;

app.listen(PORT, "0.0.0.0", () => {
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  console.log(`NightWay dispatch (SIMULATED) on port ${PORT}`);
  console.log(`  dashboard: http://localhost:${PORT}/`);
  for (const ip of lan) console.log(`  phone on the same Wi-Fi: http://${ip}:${PORT}  (put this in the app's Demo drawer)`);
});

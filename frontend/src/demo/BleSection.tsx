import { useEffect, useState } from "react";
import { CONFIG } from "../config";
import { useT } from "../copy";
import { ble, getDispatchUrl, meshMode, setRealBluetooth } from "../sos";
import { BleMeshTransport, type Diagnosis } from "../sos/ble";
import { ago } from "./demoApi";

/** Demo drawer: the real Bluetooth relay. Switch, live counters, a test packet for the two-phone check. */
export function BleSection() {
  const { t } = useT();
  const [, redraw] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const check = () => { if (BleMeshTransport.available()) BleMeshTransport.diagnose().then(setDiag).catch((e) => setMsg(`check failed: ${e?.message ?? e}`)); };
  useEffect(check, []);
  useEffect(() => {
    const off = ble.watch(() => redraw((n) => n + 1));
    const id = window.setInterval(() => redraw((n) => n + 1), 1000);
    return () => { off(); window.clearInterval(id); };
  }, []);

  const available = BleMeshTransport.available();
  const on = meshMode.real && ble.running;
  const flip = async () => {
    setBusy(true);
    const err = await setRealBluetooth(!on, { title: t("label.appName"), text: t("line.meshOn") });
    setMsg(err ? `Could not start: ${err}. Help uses the simulated mesh.` : !on ? "Real Bluetooth ON: this phone relays and, if it reaches the server, acts as gateway." : "Real Bluetooth OFF");
    setBusy(false);
    check();
  };
  const s = ble.stats;
  const here = { lat: 28.5705, lon: 77.3229 };
  return (
    <div className="space-y-2">
      <button onClick={flip} disabled={!available || busy} aria-pressed={on}
        className={`flex min-h-14 w-full items-center justify-between rounded-2xl border px-4 font-bold disabled:opacity-40 ${on ? "border-good/60 bg-good/10" : "border-edge bg-raised"}`}>
        <span>Real Bluetooth relay</span><span className={on ? "text-good" : "text-soft"}>{busy ? "…" : on ? "ON" : "OFF"}</span>
      </button>
      {!available && <p className="text-[0.9rem] text-soft">Only in the Android app (not in the browser).</p>}
      {diag && (
        <div className="rounded-2xl bg-raised px-3 py-2 text-[0.9rem]">
          <p className="font-semibold">Checks · {diag.model} · Android API {diag.android}</p>
          <ul className="mt-1 space-y-0.5">
            {([
              ["Bluetooth LE hardware", diag.hasBle, ""],
              ["Bluetooth switched on", diag.bluetoothOn, "turn Bluetooth on"],
              ["Phone can broadcast (BLE advertising)", diag.canAdvertise, "this phone cannot send; it can still listen and pass on nothing"],
              ["Location switched on", diag.locationOn, "Android only returns Bluetooth scan results with Location on"],
              ...Object.entries(diag.permissions).map(([k, v]) => [`Permission: ${k === "ble" ? "Nearby devices" : k}`, v === "granted", `is "${v}": Settings → Apps → NightWay → Permissions`] as [string, boolean, string]),
              ["Relay running", diag.running, "switch it ON above"],
            ] as [string, boolean, string][]).map(([label, ok, fix]) => (
              <li key={label} className={ok ? "text-good" : "text-bad"}>{ok ? "✓" : "✗"} {label}{!ok && fix ? ` (${fix})` : ""}</li>
            ))}
            {diag.lastError && <li className="text-bad">Last error: {diag.lastError}</li>}
          </ul>
          <button onClick={check} className="mt-1 min-h-11 rounded-xl border border-edge px-3 font-semibold">Check again</button>
        </div>
      )}
      {msg && <p className="text-[0.9rem] text-accent">{msg}</p>}
      {on && (
        <>
          <p className="text-[0.9rem]">
            Phones seen (last 60 s): <b>{s.peers}</b> · sent <b>{s.sent}</b> · relayed <b>{s.relayed}</b> · last packet{" "}
            <b>{s.lastPacketAt ? `${ago((Date.now() - s.lastPacketAt) / 1000)} ago` : "never"}</b>
          </p>
          <button onClick={() => ble.sendTest(here)} className="min-h-12 w-full rounded-2xl border border-edge bg-raised px-3 font-semibold">
            Send test packet (relayed, never posted)
          </button>
          {ble.heard.length > 0 && (
            <ol className="max-h-40 space-y-0.5 overflow-y-auto font-mono text-[0.8rem]">
              {ble.heard.map((h, i) => (
                <li key={i} className={h.type === "ack" ? "text-good" : h.to === "test" ? "text-soft" : "text-warn"}>
                  {new Date(h.t).toLocaleTimeString()} heard {h.type}→{h.to} #{h.id} hop {h.hop} rssi {h.rssi}
                </li>
              ))}
            </ol>
          )}
          {ble.logs.length > 0 && <p className="font-mono text-[0.75rem] text-soft">{ble.logs.slice(0, 4).join(" · ")}</p>}
        </>
      )}
      <p className="text-[0.85rem] text-soft">
        BLE advertisements, test company ID 0xFFFF, 18-byte packet (id, type, desk, ttl, hop, lat, lon, time), no signature (it does not fit).
        Dedupe by id, hop limit {CONFIG.mesh.ttl}, relay after a random 0.1–0.5 s. A phone that reaches the dispatch server ({getDispatchUrl()}) posts what it hears
        and sends the acknowledgement back. Range is short; it only helps if phones nearby run NightWay; Android may slow it in the background.
      </p>
    </div>
  );
}

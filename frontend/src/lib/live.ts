import { useEffect, useRef, useState } from "react";
import { CONFIG } from "../config";
import { call, listen } from "./engine";

const CURRENT = "temperature_2m,precipitation,rain,weather_code,wind_speed_10m";

/** One real Open-Meteo "current weather" reading. Returns false when it can't be reached. */
async function probe(center: { lat: number; lon: number }): Promise<boolean> {
  try {
    const u = `${CONFIG.live.weatherUrl}?latitude=${center.lat}&longitude=${center.lon}&current=${CURRENT}&timezone=GMT`;
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(u, { signal: ctl.signal });
    window.clearTimeout(timer);
    if (!r.ok) return false;
    const j = (await r.json()) as { current?: Record<string, number | string | null> };
    if (!j.current) return false;
    await call("setRealWeather", j.current, Date.now());
    return true;
  } catch { return false; }
}

/** The Live / Offline pill (spec §8): Live when the phone is online, the weather probe worked
 *  recently and live information is coming in. Otherwise the engine plans on saved info. */
export function useLive(center: { lat: number; lon: number } | null): "live" | "offline" {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [probeAt, setProbeAt] = useState<number | null | undefined>(undefined);   // undefined: not tried yet
  const [engineSays, setEngineSays] = useState<"live" | "offline">("live");
  const [, setNow] = useState(0);
  const busy = useRef(false);

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const stop = listen((m) => { if (m.type === "status") { setEngineSays(m.connection); setNow(m.now); } });
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); stop(); };
  }, []);

  useEffect(() => {
    if (!center) return;
    const run = () => {
      if (busy.current || !navigator.onLine) return;
      busy.current = true;
      probe(center).then((ok) => { if (ok) setProbeAt(Date.now()); else setProbeAt(null); }).finally(() => { busy.current = false; });
    };
    if (online) run();
    const id = window.setInterval(run, CONFIG.live.weatherProbeEveryS * 1000);
    return () => window.clearInterval(id);
  }, [center?.lat, center?.lon, online]); // eslint-disable-line react-hooks/exhaustive-deps

  const reachable = online && probeAt != null && Date.now() - probeAt < CONFIG.live.weatherProbeOkS * 1000;
  const known = !online || probeAt !== undefined;
  useEffect(() => { if (known) call("setOnline", reachable).catch(() => {}); }, [reachable, known]);
  return reachable && engineSays === "live" ? "live" : "offline";
}

import { useEffect, useRef, useState } from "react";
import { api } from "../api";

/** Live / Offline for the status pill.
 *  Offline when: the phone has no network, the server can't be reached, or the server
 *  says no live information is coming in (e.g. "All live info" switched off in Demo). */
export function useConnection(planSays: "live" | "offline" | null): "live" | "offline" {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [server, setServer] = useState<"live" | "offline" | "down">("live");
  const airplane = useRef(false);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  // Demo laptop in airplane mode still reaches its local server: tell the simulator that
  // live information stopped, so the plan really runs on saved info (and restore it later).
  useEffect(() => {
    if (!online && !airplane.current) {
      airplane.current = true;
      fetch("/api/sim/outage", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "all_live", enabled: false }) }).catch(() => {});
    } else if (online && airplane.current) {
      airplane.current = false;
      fetch("/api/sim/outage", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "all_live", enabled: true }) }).catch(() => {});
    }
  }, [online]);

  useEffect(() => {
    let stop = false;
    const poll = () => api.status().then((s) => !stop && setServer(s.connection)).catch(() => !stop && setServer("down"));
    poll();
    const id = window.setInterval(poll, 4000);
    return () => { stop = true; window.clearInterval(id); };
  }, []);

  if (!online || server !== "live" || planSays === "offline") return "offline";
  return "live";
}

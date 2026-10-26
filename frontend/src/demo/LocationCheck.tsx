import { Geolocation } from "@capacitor/geolocation";
import { useState } from "react";
import { call } from "../lib/engine";

/** Demo drawer: is GPS working, and is the phone inside the area the app has data for? */
export function LocationCheck() {
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const [cfg, perm] = await Promise.all([call("init"), Geolocation.checkPermissions().catch(() => null)]);
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      const [hit, used] = await Promise.all([call("areaHit", lat, lon), call("inArea", lat, lon)]);
      const km = hit.distM / 1000;
      setOut(`GPS works: ${lat.toFixed(5)}, ${lon.toFixed(5)} (±${Math.round(accuracy)} m), permission ${perm?.location ?? "?"}. ` +
        (hit.inside ? `Inside the zone “${hit.zone}”. ` : `${km < 10 ? km.toFixed(2) : Math.round(km)} km from the nearest zone (“${hit.zone}”). `) +
        `The app has data for: ${cfg.zones.map((z) => z.name).join(", ")}. ` +
        (used ? "“My location” uses this fix." : "Outside: the app uses the demo start point (“My location (demo)”)."));
    } catch (e) {
      setOut(`No GPS fix: ${(e as Error)?.message ?? e}. Check Location is on and NightWay has location permission.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-3 rounded-2xl bg-raised px-3 py-2 text-[0.9rem]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">Your location (GPS)</span>
        <button onClick={run} disabled={busy} className="min-h-11 rounded-xl border border-edge px-3 font-semibold disabled:opacity-50">{busy ? "Checking…" : "Check"}</button>
      </div>
      {out && <p className="mt-1">{out}</p>}
    </div>
  );
}

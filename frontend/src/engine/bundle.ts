// Loads the data bundled in the APK (src/data/*.json, written by tools/build_data.py).
// The files are emitted as static assets and fetched at start-up (works with no network:
// in the APK they are local files).
import graphUrl from "../data/graph.json?url";
import incidentsUrl from "../data/incidents.json?url";
import metaUrl from "../data/meta.json?url";
import placesUrl from "../data/places.json?url";
import poisUrl from "../data/pois.json?url";
import scheduleUrl from "../data/schedule.json?url";
import weatherUrl from "../data/weather.json?url";
import type { Bundle } from "./world";

export async function fetchBundle(): Promise<Bundle> {
  const get = async <T>(u: string): Promise<T> => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json() as Promise<T>; };
  const [graph, pois, places, weather, incidents, schedule, meta] = await Promise.all([
    get<Bundle["graph"]>(graphUrl), get<Bundle["pois"]>(poisUrl), get<Bundle["places"]>(placesUrl), get<Bundle["weather"]>(weatherUrl),
    get<Bundle["incidents"]>(incidentsUrl), get<Bundle["schedule"]>(scheduleUrl), get<Bundle["meta"]>(metaUrl),
  ]);
  return { graph, pois, places, weather, incidents, schedule, meta };
}

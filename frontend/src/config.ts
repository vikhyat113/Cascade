// Every threshold, weight and timing the engine and UI use (spec §5: numbers only here).

export type SourceId =
  | "osm_map" | "osm_hours" | "weather_forecast" | "weather" | "traffic" | "transit_realtime"
  | "closures" | "transit_schedule" | "incident_history";

export interface SourceCfg {
  label: string;
  kind: "observed" | "scheduled" | "inferred" | "prior";
  ttlS: number;
  reliability: number;
  synthetic: boolean;
  live: boolean;           // can go stale while the app runs (and can be switched off in Demo)
  dropout?: number;        // chance per tick that a simulated reading is lost
  maxDelayS?: number;      // readings arrive this late at most
  coverage?: number;       // share of cells / trips reported per tick
}

export const SOURCES: Record<SourceId, SourceCfg> = {
  osm_map: { label: "OpenStreetMap streets & places", kind: "observed", ttlS: 31536000, reliability: 0.85, synthetic: false, live: false },
  osm_hours: { label: "OSM opening hours", kind: "observed", ttlS: 31536000, reliability: 0.8, synthetic: false, live: false },
  weather_forecast: { label: "Open-Meteo forecast (saved)", kind: "inferred", ttlS: 172800, reliability: 0.75, synthetic: false, live: false },
  weather: { label: "Weather now", kind: "observed", ttlS: 900, reliability: 0.8, synthetic: false, live: true, dropout: 0.03, maxDelayS: 60 },
  traffic: { label: "Traffic speeds", kind: "observed", ttlS: 120, reliability: 0.85, synthetic: true, live: true, dropout: 0.05, maxDelayS: 30, coverage: 0.85 },
  transit_realtime: { label: "Bus positions", kind: "observed", ttlS: 120, reliability: 0.9, synthetic: true, live: true, dropout: 0.05, maxDelayS: 20, coverage: 0.9 },
  closures: { label: "Road closures", kind: "observed", ttlS: 600, reliability: 0.8, synthetic: true, live: true, dropout: 0.03, maxDelayS: 30 },
  transit_schedule: { label: "Night bus timetable", kind: "scheduled", ttlS: 2592000, reliability: 0.7, synthetic: true, live: false },
  incident_history: { label: "Incident history (90 nights)", kind: "inferred", ttlS: 31536000, reliability: 0.6, synthetic: true, live: false },
};

export const LIVE_SOURCES: SourceId[] = ["weather", "traffic", "transit_realtime", "closures"];

export const CONFIG = {
  freshness: {
    knownMinReliability: 0.7,
    outdatedFactor: 3,        // observed: ttl < age <= 3*ttl -> PROBABLE, beyond -> OUTDATED
    unusableFactor: 10,       // observed: older than 10*ttl -> UNKNOWN
    coverageThreshold: 0.3,   // share of a way that drags a category down to a weaker status
    outdatedDiscount: 0.5,
    decayScale: 3,            // confidence = rel * exp(-age / (decayScale*ttl)); 1 = literal exp(-age/ttl)
    kindCaps: { observed: 1.0, scheduled: 0.8, inferred: 0.65, prior: 0.4 },
  },
  risk: {
    weights: { lighting: 0.24, incident: 0.24, isolation: 0.2, traffic: 0.1, weather: 0.1, emergency: 0.12 },
    trafficCellM: 500,
    vehicleFactor: 0.35,
    transitRideFactor: 0.3,
    safeHavenWaitRisk: 0.08,
    nightHours: [19, 6] as [number, number],
    // Lighting prior from satellite night lights (VIIRS) for streets with no lit tag and no lamps:
    // PROBABLE (never KNOWN), only when the area is bright / dark enough to say something.
    viirsPrior: true,
    viirsBright: 220,           // relative brightness 0-255 (see scripts/fetch_viirs.py)
    viirsDark: 140,
    viirsRisk: { bright: [0.15, 0.55], mid: [0.3, 0.75], dark: [0.5, 0.95] } as Record<string, [number, number]>,
  },
  planner: {
    lambdas: [0, 0.5, 1, 2, 4],
    riskCostSPerM: 0.8,
    walkSpeed: { best: 1.45, expected: 1.25, worst: 1.0 },   // m/s
    maxWalkM: 2500,
    maxAccessWalkM: 1200,
    dedupeOverlap: 0.85,
    hysteresisPoints: 5,
    hysteresisEtaS: 300,
    etaChangeLogS: 180,
    stopBufferS: 60,
    safeHavenRadiusM: 200,
    busSpeedMps: 7,
    // Yen's K-shortest diverse walking ways (U3): only for walkable trips, small corridor, time budget
    yen: { k: 4, maxK: 8, budgetMs: 400, corridorM: 600, maxStraightM: 3500 },
  },
  transit: {
    maxTransfers: 2,          // changes between vehicles (A -> C -> B is one)
    transferRadiusM: 250,     // walk between stops to change
    transferPenaltyS: 300,    // per change: prefer direct trips when they are about as fast
    unknownHeadwayMin: 30,    // expected wait when even the headway is unknown
    clusterM: 60,             // stops this close with the same name are one place
    maxItineraries: 4,
    maxWaitMin: 60,           // a vehicle further off than this is "no service until hh:mm", never a way (a 6 h wait for the first metro)
  },
  presentation: {
    // UI_SPEC suggests 75 / 50; worst-case scores here sit between ~40 (long dark walk) and ~72 (inside a
    // vehicle most of the way), calibrated so a bus ride reads Safe/OK and a long unlit walk Be careful.
    safeMin: 66,
    okMin: 55,
    bannerMaxAgeS: 600,
  },
  sim: {
    tickMs: 2000,             // real ms between engine ticks in the app
    warmupS: 300,
    stepS: 30,                // fast-forward step
  },
  live: {
    weatherUrl: "https://api.open-meteo.com/v1/forecast",
    weatherProbeEveryS: 900,  // real Open-Meteo probe when online
    weatherProbeOkS: 1800,    // pill says Live if the last probe is newer than this
  },
  here: {
    // HERE Raster Tile API v3 (night style) and Traffic API v7 / Public Transit API v8. Free allowances are per
    // product, so calls are throttled and answers cached in memory (never on disk, never for offline use)
    tileUrl: "https://maps.hereapi.com/v3/base/mc/{z}/{x}/{y}/png",
    tileStyle: "explore.night",
    flowUrl: "https://data.traffic.hereapi.com/v7/flow",
    transitUrl: "https://transit.router.hereapi.com/v8/routes",
    traffic: true,            // use HERE traffic flow as the real traffic source when it answers
    trafficEveryS: 180,       // poll while online
    trafficTtlS: 600,         // a HERE reading counts as fresh this long, then it ages like any live source
    nearRealS: 1800,          // only used while the app clock is this close to real time (not in a "23:00" demo jump)
    cacheS: 180,              // same request inside this window -> the saved answer
    minGapS: { tiles: 0, traffic: 60, transit: 10 } as Record<"tiles" | "traffic" | "transit", number>,
  },
  area: {
    nearM: 300,               // "in the area": inside a zone or this close to one
  },
  map: {
    // online basemap: HERE night tiles when a key exists (UPGRADE §9), else OpenStreetMap standard (light use,
    // with attribution). HERE fails -> OSM -> the road network bundled in the app, so the map always works offline
    provider: ((import.meta.env.VITE_MAP_PROVIDER ?? (import.meta.env.VITE_HERE_API_KEY ? "here" : "osm")) === "here" ? "here" : "osm") as "here" | "osm",
    tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
    tileErrorsBeforeRoads: 3,
    boundsPadM: 3000,         // the map can be panned this far beyond the zones (data stops at the zone edge)
  },
  dispatch: {
    // the phone reaches the laptop over Wi-Fi: set VITE_DISPATCH_URL at build time or in the Demo drawer
    defaultUrl: import.meta.env.VITE_DISPATCH_URL || "http://localhost:8787",
    ackTimeoutS: 20,          // escalate to the next helper after this (UPGRADE §8)
    demoAckTimeoutS: 8,       // ... with the Demo "Short help steps" switch
    reachTimeoutMs: 2500,     // "can the phone reach the server?" check
    sendTimeoutMs: 5000,
    pollMs: 2000,             // ask the server for an acknowledgement this often
    // who is asked first, then next, when nobody acknowledges
    // then the nearest open place with people (24 h pharmacy, fuel, hotel): see sos/ladder.ts
    ladder: { danger: ["police", "hospital", "fire"], medical: ["hospital", "police", "fire"], unsure: ["police", "hospital", "fire"] } as Record<string, ("police" | "hospital" | "fire")[]>,
  },
  mesh: {
    nodes: 6,                 // virtual phones in the simulated mesh (node 0 = this phone, last = gateway)
    ttl: 5,                   // hop limit
    hopMs: [300, 900] as [number, number],   // random relay delay per hop
    gatewayRetryMs: 3000,     // store-and-forward: gateway retries the server this often
    // MESH_REAL: the real Bluetooth relay (Phase 7). Off unless switched on in the Demo drawer (remembered
    // on the phone); falls back to the simulated mesh whenever Bluetooth or the plugin is unavailable.
    realDefault: false,
  },
  deviation: {                 // UPGRADE §7, tuned for walking
    maxAccuracyM: 50,           // ignore fixes worse than this
    consecutive: 3,             // fixes in a row beyond the line before anything is said
    backAfter: 2,               // fixes back on the way to clear a warning
    offM: 60,                   // "You are off the way." beyond this ...
    offAfterS: 20,              // ... for this long
    farM: 250,                  // "You are far from the way." beyond this ...
    farAfterS: 180,             // ... or off the way for this long
    offVehicleM: 150,           // on a bus / metro ride the line is wider
    farVehicleM: 500,
    snoozeS: 180,               // "I'm fine"
    stillAfterS: 300,           // "Are you OK?" after this long without moving, at night
    stillMoveM: 25,
    fakeStepMs: 1000,           // Demo "Walk the way": one fake fix per second
  },
  safetyTimer: {
    afterDeadlineMin: 10,     // "Are you home?" this long after "Be there by"
    answerWithinMin: 5,       // no answer by then: alert the contact (simulated) and offer the text
    checkMs: 5000,
  },
};

export type RiskComponent = keyof typeof CONFIG.risk.weights;
export const COMPONENTS: RiskComponent[] = ["lighting", "incident", "isolation", "traffic", "weather", "emergency"];

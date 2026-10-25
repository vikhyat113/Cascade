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
    cabZoneM: 1000,
    vehicleFactor: 0.35,
    transitRideFactor: 0.3,
    safeHavenWaitRisk: 0.08,
    nightHours: [19, 6] as [number, number],
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
  },
  cab: { baseWaitMin: { 22: 5, 23: 6, 0: 7, 1: 9, 2: 11, 3: 12, 4: 10, 5: 7 } as Record<number, number> },
  presentation: {
    // UI_SPEC suggests 75 / 50; worst-case scores here sit between ~40 (long dark walk) and ~72 (cab),
    // so they are calibrated so a cab reads Safe, a night bus OK and a long unlit walk Be careful.
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
  dispatch: {
    // the phone reaches the laptop over Wi-Fi: set VITE_DISPATCH_URL at build time or in the Demo drawer
    defaultUrl: import.meta.env.VITE_DISPATCH_URL || "http://localhost:8787",
    ackTimeoutS: 20,          // demo: short; escalate to the next helper after this
    reachTimeoutMs: 2500,     // "can the phone reach the server?" check
    sendTimeoutMs: 5000,
    pollMs: 2000,             // ask the server for an acknowledgement this often
    // who is asked first, then next, when nobody acknowledges
    ladder: { danger: ["police", "hospital"], medical: ["hospital", "police"], unsure: ["police", "hospital"] } as Record<string, ("police" | "hospital")[]>,
  },
  mesh: {
    nodes: 6,                 // virtual phones in the simulated mesh (node 0 = this phone, last = gateway)
    ttl: 5,                   // hop limit
    hopMs: [300, 900] as [number, number],   // random relay delay per hop
    gatewayRetryMs: 3000,     // store-and-forward: gateway retries the server this often
  },
  safetyTimer: {
    afterDeadlineMin: 10,     // "Are you home?" this long after "Be there by"
    answerWithinMin: 5,       // no answer by then: alert the contact (simulated) and offer the text
    checkMs: 5000,
  },
};

export type RiskComponent = keyof typeof CONFIG.risk.weights;
export const COMPONENTS: RiskComponent[] = ["lighting", "incident", "isolation", "traffic", "weather", "emergency"];

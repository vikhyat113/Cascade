// Shapes of the backend's simple view (backend/app/presentation/simple_view.py).
export type LatLon = [number, number];

export interface Place {
  lat: number;
  lon: number;
  name: string;
  kind?: "home" | "work" | "here" | null;
  demo?: boolean;
}

export interface Step { icon: "walk" | "wait" | "bus" | "metro" | "cab"; minutes: number; text: string; line?: string }

export interface PlaceOnWay {
  id: string; type: string; name: string; distance_m: number; distance_text: string;
  state: "open" | "maybe_open" | "not_sure"; state_text: string; lat: number; lon: number;
  minutes?: number; minutes_text?: string; path?: LatLon[];
}

export interface Option {
  id: string; label: string; tab: boolean; plan_id: string; kind: string; same_as: string | null; same_text?: string;
  arrive_text: string; arrive_time: string | null;
  timing: "on_time" | "maybe_late" | "too_late" | "none"; timing_text: string | null; late_text: string | null;
  safety_level: "safe" | "ok" | "careful"; safety_text: string; safety_reason: string;
  steps: Step[];
  warning: { text: string; pill: string | null; backup_option_id: string | null } | null;
  backup_option_id?: string | null;
  places: PlaceOnWay[];
  path: LatLon[]; start: LatLon | null; end: LatLon | null;
}

export interface Trip {
  option_id: string; step_index: number; progress: number; arrived: boolean;
  next_text: string; next_icon: string; minutes_left: number; position: LatLon | null;
}

export interface SimpleView {
  id: string; lang: string; phase: string; now_text: string; connection: "live" | "offline";
  options: Option[]; current_option_id: string | null;
  banner: { id: string; text: string; see_option_id: string | null } | null;
  trip: Trip | null; deadline_text: string | null; error_text: string | null;
  details: any;  // technical plan set, only read by the Demo drawer
}

export interface UiDefaults { home: Place; work: Place; start: Place; deadline: string | null }

export interface AppConfig {
  city_name: string;
  center: { lat: number; lon: number };
  radius_m: number;
  area_mode?: "polygon" | "circle_fallback";
  area_source?: string;
  vertex_count?: number;
  area_km2?: number;
  bbox?: [number, number, number, number];
  placeholder_suspect?: boolean;
  polygon?: { type: "Polygon"; coordinates: [number, number][][] } | null;
  ui_defaults: UiDefaults;
}

export interface AreaDiagnostics {
  area_mode: "polygon" | "circle_fallback";
  area_source: string;
  source_mtime: string;
  vertex_count: number;
  area_km2: number;
  bbox: [number, number, number, number];
  placeholder_suspect: boolean;
  walk_nodes: number;
  walk_edges: number;
  drive_nodes: number;
  drive_edges: number;
  walk_nodes_inside: number;
  drive_nodes_inside: number;
  share_nodes_inside: number;
  pois_inside: number;
  pois_outside: number;
  walk_generated_at: string;
  pois_generated_at: string;
  stale_data: boolean;
}

export type StatusTier = "KNOWN" | "PROBABLE" | "OUTDATED" | "UNKNOWN";
export type StatusChip = "LIVE" | "CACHED" | "STALE" | "OFFLINE";
export type ViewMode = "streets" | "smooth" | "cells";

export interface MoonIllumination {
  fraction: number;
  percent: number;
  phase_name: string;
  altitude_deg?: number;
  azimuth_deg?: number;
  label: string;
  computed_not_measured?: boolean;
}

export interface OriginForecastPoint {
  hour: number;
  time: string;
  temperature_2m: number | null;
  apparent_temperature: number | null;
  precipitation?: number;
}

export interface LayerMeta {
  id: string;
  name: string;
  source: string;
  product?: string;
  date_range?: string | null;
  retrieved_at?: string | null;
  native_resolution: string;
  units: string;
  license: string;
  attribution: string;
  status: StatusTier;
  status_chip?: StatusChip;
  confidence: number;
  age_s: number | null;
  available: boolean;
  cell_count: number;
  unknown_share: number;
  synthetic: boolean;
  live?: boolean;
  note: string;
  error?: string;
  older_than_area?: boolean;
  moon_illumination?: MoonIllumination;
  last_satellite_pass?: string;
  last_pass_date?: string;
  days_ago?: number;
  history_window_nights?: number;
  microclimate_note?: string;
}

export type FacilityCategory = "medicine" | "food" | "hospital" | "police";
export type HoursTier = "open" | "maybe_open" | "unknown" | "closed";

export interface FacilityPOI {
  id: string;
  name: string;
  cat: string;
  category_group: FacilityCategory | null;
  lat: number;
  lon: number;
  tier: HoursTier;
  hours_state: {
    tier: HoursTier;
    open: boolean | null;
    status: string;
    text: string;
    note?: string;
  };
  last_osm_edit: string | null;
  is_24h: boolean;
  dist_m?: number;
  walk_min?: number;
}

export type RouteMetrics = {
  eta: { best: string | null; expected: string | null; worst: string | null };
  duration_min: { best: number | null; expected: number | null; worst: number | null };
  safety: { lo: number; hi: number };
  safety_status: string;
  outdoor_min: number;
  unknown_lighting_share: number;
  safe_haven_dist_m: number;
  distance_m: number;
  feasible: { best: boolean; expected: boolean; worst: boolean };
  slack_min: number;
  limiting_label: string;
  limiting_status: string;
};

export type RouteItem = {
  id: string;
  index: number;
  label: string;
  kind: string;
  title: string;
  polyline: [number, number][];
  metrics: RouteMetrics;
  dominated: boolean;
  infeasible_worst: boolean;
  score: number;
  score_breakdown: Record<string, number>;
  why: string;
  loss_reason: string;
  recommended: boolean;
  telemetry?: RouteTelemetry | null;
};

export type PlanRoutesResponse = {
  plan_id: string;
  routes: RouteItem[];
  tie: boolean;
  tie_note: string | null;
  routing_time_ms: number;
};

/** A single event on a route's telemetry timeline. */
export interface TelemetryEvent {
  id: string;
  type: "poi" | "road_class" | "lighting" | "gap_warning" | "closure" | "crossing" | "walk_section";
  name: string;
  chainage_m: number;
  offset_m: number;
  eta_expected_s: number;
  eta_best_s: number;
  eta_worst_s: number;
  hours_state: "open" | "maybe_open" | "unknown" | "closed";
  tier: "KNOWN" | "PROBABLE" | "OUTDATED" | "UNKNOWN";
  source: string;
  last_osm_edit?: string | null;
  icon_key: string;
  length_m?: number;       // for gap_warning and lighting stretches
  road_class?: string;     // for road_class events
}

/** Telemetry for one route */
export interface RouteTelemetry {
  route_id: string;
  total_length_m: number;
  events: TelemetryEvent[];
  max_gap_m: number;
  unknown_lighting_m: number;
  computed_at: string;
  error?: string | null;
}


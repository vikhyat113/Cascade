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

export interface AppConfig { city_name: string; center: { lat: number; lon: number }; radius_m: number; ui_defaults: UiDefaults }

// Shapes the screens render: the engine's simple view (src/engine/simpleView.ts).
export type { LatLon, Option, PlaceOnWay, SimpleView, Step, TripState as Trip } from "./engine/simpleView";
export type { AppConfig } from "./lib/engine";

export interface Place {
  lat: number;
  lon: number;
  name: string;
  kind?: "home" | "work" | "here" | null;
  demo?: boolean;
}

export interface UiDefaults { home: Place; work: Place; start: Place; deadline: string | null }

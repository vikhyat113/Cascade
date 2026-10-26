// Builds the World from the bundled data once for all engine tests (node, no fetch).
import graph from "../../data/graph.json";
import incidents from "../../data/incidents.json";
import meta from "../../data/meta.json";
import places from "../../data/places.json";
import pois from "../../data/pois.json";
import schedule from "../../data/schedule.json";
import weather from "../../data/weather.json";
import { Engine } from "../engine";
import type { Mode, PlanRequest } from "../planner";
import { point, scenarioNight } from "../scenarios";
import { ManualClock } from "../time";
import { World, type Bundle } from "../world";

let world: World | null = null;
export function testWorld(): World {
  world ??= new World({ graph, pois, places, weather, incidents, schedule, meta } as unknown as Bundle);
  return world;
}

/** An engine on the scenario night, clock at 02:05, feeds warmed up (deterministic). */
export function testEngine(seed = 7): Engine {
  const w = testWorld();
  return new Engine(w, new ManualClock(w.city.atNight("02:05", scenarioNight(w))), { live: false, warmup: true, seed });
}

export function workHome(e: Engine, o: { modes?: Mode[]; by?: string; finish?: string; along?: "bus" } = {}): PlanRequest {
  const w = e.world, d = w.meta.ui_defaults, ref = scenarioNight(w);
  const [origin, destination] = o.along === "bus"           // along a bus route: tests of the timetable logic
    ? [{ ...point(w, "bus:start"), kind: null }, { ...point(w, "bus:end"), kind: null }]
    : [{ ...d.work, kind: "work" as const }, { ...d.home, kind: "home" as const }];
  return { origin, destination, start: w.city.atNight(o.finish ?? "02:15", ref),
    deadline: w.city.atNight(o.by ?? "03:00", ref), modes: o.modes ?? ["walk", "bus", "metro"], riskWeight: 1, maxWalkM: 2500 };
}

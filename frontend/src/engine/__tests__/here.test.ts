import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "../../config";
import { flowSamples } from "../../lib/here";
import { Engine } from "../engine";
import { scenarioNight } from "../scenarios";
import { ManualClock } from "../time";
import { testWorld } from "./world.fixture";

vi.mock("../../lib/engine", () => ({ call: vi.fn(), listen: vi.fn(() => () => {}) }));

const traffic = (e: Engine) => e.trust().sources.find((s) => s.id === "traffic")!;

describe("HERE traffic flow (UPGRADE §9)", () => {
  it("reads one sample per road piece: middle point, current / free-flow speed, closed = 0.1", () => {
    const pts = flowSamples({ results: [
      { location: { shape: { links: [{ points: [{ lat: 21.1, lng: 79.0 }, { lat: 21.2, lng: 79.1 }, { lat: 21.3, lng: 79.2 }] }] } }, currentFlow: { speed: 5, freeFlow: 10 } },
      { location: { shape: { links: [{ points: [{ lat: 21.0, lng: 79.0 }] }] } }, currentFlow: { traversability: "closed" } },
      { location: { shape: { links: [{ points: [{ lat: 21.0, lng: 79.0 }] }] } }, currentFlow: {} },          // no speeds: skipped
    ] });
    expect(pts).toEqual([{ lat: 21.2, lon: 79.1, f: 0.5 }, { lat: 21.0, lon: 79.0, f: 0.1 }]);
    expect(flowSamples({})).toEqual([]);
  });

  it("is a real (not simulated) source while it answers, ages when it stops, and a clock jump goes back to simulated", () => {
    const w = testWorld();
    const e = new Engine(w, new ManualClock(Date.now()), { live: false, warmup: true, seed: 3 });
    expect(traffic(e).synthetic).toBe(true);
    // HERE samples on every car street's middle point, all at 60 % of free flow
    const pts: { lat: number; lon: number; f: number }[] = [];
    for (let i = 0; i < w.m; i += 7) if (w.carOk[i]) pts.push({ lat: w.proj.lat(w.emy[i]), lon: w.proj.lon(w.emx[i]), f: 0.6 });
    const cells = e.setRealTraffic(pts, Date.now());
    expect(cells).toBeGreaterThan(0);
    e.advance(30);
    const t = traffic(e);
    expect(t).toMatchObject({ synthetic: false, status: "KNOWN", label: "Traffic speeds (HERE live)" });
    const c = [...e.state.realTraffic!.cells.keys()][0];
    expect(e.state.get(`traffic:cell:${c}`)).toMatchObject({ synthetic: false, value: { speed_factor: 0.6 }, note: "HERE traffic flow" });
    // no new HERE reading for 20 min: it ages instead of being filled with simulated data
    for (let i = 0; i < 40; i++) e.advance(30);
    expect(traffic(e).synthetic).toBe(false);
    expect(traffic(e).status).not.toBe("KNOWN");
    // Demo jump to a night far from real time: simulated traffic again, and labelled so
    e.setClock({ time: w.city.atNight("23:00", scenarioNight(w)) });
    e.advance(30);
    expect(traffic(e)).toMatchObject({ synthetic: true, label: "Traffic speeds" });
  });

  it("ignores samples outside the area", () => {
    const e = new Engine(testWorld(), new ManualClock(Date.now()), { live: false, warmup: false, seed: 3 });
    expect(e.setRealTraffic([{ lat: 28.6, lon: 77.2, f: 0.5 }], Date.now())).toBe(0);
    expect(e.state.realTraffic).toBeNull();
  });
});

describe("map tile chain", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("no key: OpenStreetMap only (then the bundled roads)", async () => {
    vi.stubEnv("VITE_HERE_API_KEY", "");
    vi.resetModules();
    const h = await import("../../lib/here");
    expect(h.hereKey()).toBeNull();
    expect(h.tileChain().map((t) => t.id)).toEqual(["osm"]);
  });

  it("with a key: HERE night tiles first with the © HERE credit, then OSM; the Demo test breaks them in order", async () => {
    vi.stubEnv("VITE_HERE_API_KEY", "x".repeat(40));
    vi.resetModules();
    const { CONFIG: C } = await import("../../config");
    const h = await import("../../lib/here");
    expect(C.map.provider).toBe("here");
    const [here, osm] = h.tileChain();
    expect(here.id).toBe("here");
    expect(here.url).toContain(`${CONFIG.here.tileUrl}?style=${CONFIG.here.tileStyle}`);
    expect(here.attribution).toMatch(/© \d{4} HERE/);
    expect(osm.id).toBe("osm");
    h.setTileTest("here_fails");
    expect(h.tileChain().map((t) => t.url.includes("invalid"))).toEqual([true, false]);
    h.setTileTest("all_fail");
    expect(h.tileChain().map((t) => t.url.includes("invalid"))).toEqual([true, true]);
  });
});

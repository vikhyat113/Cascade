import { describe, expect, it } from "vitest";
import { runScenario, SCENARIOS } from "../scenarios";
import { testWorld } from "./world.fixture";

describe("scenario harness", () => {
  it("has all ten scenarios", () => expect(SCENARIOS.length).toBe(10));
  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s passes", (_name, sc) => {
    const r = runScenario(testWorld(), sc);
    const failed = Object.entries(r.checks).filter(([, c]) => !c.pass).map(([k, c]) => `${k}: ${c.detail}`);
    expect(failed).toEqual([]);
    expect(r.invalid_outputs).toBe(0);
    expect(r.violations).toEqual([]);
    expect(r.passed).toBe(true);
  }, 30000);                                   // whole simulated nights; the first one also builds the World
});

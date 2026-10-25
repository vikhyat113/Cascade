// Runs the scenario harness in its own worker (about 10 s for all eight), so the app's engine keeps
// ticking while the Demo drawer waits. Each result is posted as soon as it is ready.
import { fetchBundle } from "./bundle";
import { runScenario, SCENARIOS } from "./scenarios";
import { World } from "./world";

const world = fetchBundle().then((b) => new World(b));

self.onmessage = async () => {
  const w = await world;
  for (const sc of SCENARIOS) {
    await new Promise((r) => setTimeout(r, 0));          // let the "running" state paint
    (self as unknown as Worker).postMessage({ result: runScenario(w, sc) });
  }
  (self as unknown as Worker).postMessage({ done: true });
};

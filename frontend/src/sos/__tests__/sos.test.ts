import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "../../config";
import { runLadder, type HelpState } from "../ladder";
import { SimulatedMeshTransport } from "../mesh";
import type { Dispatch, SosRequest } from "../types";

/** An in-memory dispatch server: reachable or not, and desks that acknowledge (or don't). */
function fakeServer(o: { reachable?: boolean; ackDesk?: string | null } = {}) {
  const got: SosRequest[] = [];
  const acks = new Set<string>();
  const d: Dispatch & { got: SosRequest[]; ack: (id: string) => void; online: boolean } = {
    got, online: o.reachable ?? true,
    reachable: async () => d.online,
    send: async (r) => { if (!d.online && r.via === "direct") return false; got.push(r); if (o.ackDesk && r.to === o.ackDesk) acks.add(r.id); return true; },
    acked: async (id) => acks.has(id),
    ack: (id) => { acks.add(id); },
  };
  return d;
}
const AT = { lat: 21.142, lon: 79.08 };
/** Status as the user sees it change (log lines re-send the same status). */
const seq = (states: HelpState[]) => states.map((s) => s.status).filter((x, i, a) => i === 0 || x !== a[i - 1]);
const noMesh = { broadcast: vi.fn(), onReceive: () => () => {}, status: () => ({ peers: 0, mode: "simulated" as const }) };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("help ladder", () => {
  it("sends directly and says Help is aware when police acknowledge", async () => {
    const srv = fakeServer({ ackDesk: "police" });
    const states: HelpState[] = [];
    const run = runLadder({ dispatch: srv, mesh: noMesh }, "danger", AT, (s) => states.push(s));
    await vi.advanceTimersByTimeAsync(5000);
    const end = await run.done;
    expect(seq(states)).toEqual(["sending", "passed_on", "aware"]);
    expect(end).toMatchObject({ target: "police", via: "direct", status: "aware" });
    expect(srv.got).toHaveLength(1);
    expect(srv.got[0]).toMatchObject({ to: "police", type: "danger", via: "direct" });
  });

  it("goes police -> hospital -> fire station -> open place with people, then says Not sure", async () => {
    const srv = fakeServer({ ackDesk: null });
    const states: HelpState[] = [];
    const run = runLadder({ dispatch: srv, mesh: noMesh }, "unsure", AT, (s) => states.push(s));
    await vi.advanceTimersByTimeAsync(3 * CONFIG.dispatch.ackTimeoutS * 1000 + 10000);
    expect(srv.got.map((r) => r.to)).toEqual(["police", "hospital", "fire"]);
    expect(states.some((s) => s.escalated && s.target === "hospital")).toBe(true);
    expect(states.at(-1)!).toMatchObject({ target: "place", status: "not_sure" });
    expect(states.some((s) => s.status === "aware")).toBe(false);                    // never claims help without an answer
    expect(states.at(-1)!.log).toContain("police desk: no answer. Trying hospital desk.");
    srv.ack(String(run.id));                                   // a late answer still counts
    await vi.advanceTimersByTimeAsync(CONFIG.dispatch.pollMs * 2);
    expect(states.at(-1)!.status).toBe("aware");
    run.stop();
  });

  it("uses the short step time in demo mode (8 s)", async () => {
    const srv = fakeServer({ ackDesk: null });
    const run = runLadder({ dispatch: srv, mesh: noMesh, stepS: () => CONFIG.dispatch.demoAckTimeoutS }, "danger", AT, () => {});
    await vi.advanceTimersByTimeAsync(CONFIG.dispatch.demoAckTimeoutS * 1000 + 3000);
    expect(srv.got.map((r) => r.to)).toEqual(["police", "hospital"]);
    run.stop();
  });

  it("falls back to the hospital when the police do not answer, and stops there when it does", async () => {
    const srv = fakeServer({ ackDesk: "hospital" });
    const run = runLadder({ dispatch: srv, mesh: noMesh }, "danger", AT, () => {});
    await vi.advanceTimersByTimeAsync(CONFIG.dispatch.ackTimeoutS * 1000 + 5000);
    expect(await run.done).toMatchObject({ target: "hospital", status: "aware" });
    expect(srv.got.map((r) => r.to)).toEqual(["police", "hospital"]);
  });

  it("a doctor request goes to the hospital first", async () => {
    const srv = fakeServer({ ackDesk: "hospital" });
    const run = runLadder({ dispatch: srv, mesh: noMesh }, "medical", AT, () => {});
    await vi.advanceTimersByTimeAsync(5000);
    expect((await run.done).target).toBe("hospital");
  });
});

describe("simulated mesh", () => {
  const det = () => 0.5;   // fixed relay delay

  it("carries an SOS 3 hops to the gateway, which posts it; the acknowledgement comes back", async () => {
    const srv = fakeServer({ reachable: false, ackDesk: "police" });
    const mesh = new SimulatedMeshTransport(srv, CONFIG.mesh, det);
    const states: HelpState[] = [];
    const run = runLadder({ dispatch: srv, mesh }, "danger", AT, (s) => states.push(s));
    await vi.advanceTimersByTimeAsync(10000);
    expect(srv.got).toHaveLength(1);
    expect(srv.got[0]).toMatchObject({ via: "mesh", to: "police" });
    expect(srv.got[0].hops).toBe(3);
    expect(seq(states)).toEqual(["sending", "passed_on", "aware"]);
    expect((await run.done).via).toBe("mesh");
    expect(mesh.events.some((e) => e.kind === "dup")).toBe(true);       // gossip reaches some phones twice: dropped
    mesh.dispose();
  });

  it("stores the SOS at the gateway until it has signal", async () => {
    const srv = fakeServer({ reachable: false, ackDesk: null });
    const mesh = new SimulatedMeshTransport(srv, CONFIG.mesh, det);
    mesh.gatewaySignal = false;
    mesh.broadcast({ id: 7, type: "medical", to: "hospital", lat: 1, lon: 2, ts: 0, hop: 0, ttl: 5 });
    await vi.advanceTimersByTimeAsync(10000);
    expect(srv.got).toHaveLength(0);
    expect(mesh.stats().waiting).toBe(1);
    mesh.gatewaySignal = true;
    await vi.advanceTimersByTimeAsync(CONFIG.mesh.gatewayRetryMs + 100);
    expect(srv.got.map((r) => r.id)).toEqual(["7"]);
    mesh.dispose();
  });

  it("respects the hop limit", async () => {
    const srv = fakeServer({ reachable: false });
    const mesh = new SimulatedMeshTransport(srv, { ...CONFIG.mesh, ttl: 2 }, det);
    mesh.broadcast({ id: 9, type: "danger", to: "police", lat: 1, lon: 2, ts: 0, hop: 0, ttl: 2 });
    await vi.advanceTimersByTimeAsync(10000);
    expect(srv.got).toHaveLength(0);                                    // gateway is 3 hops away
    expect(Math.max(...mesh.events.map((e) => e.to))).toBeLessThan(mesh.gateway);
    mesh.dispose();
  });
});

describe("safety timer times", () => {
  const MIN = 60000;
  it("asks 10 min after the deadline and alerts 5 min later, in real time", async () => {
    const { timerTimes } = await import("../safetyTimer");
    const t = timerTimes(1000 * MIN, 970 * MIN, 1, 0);
    expect(t).toEqual({ askAt: 40 * MIN, alertAt: 45 * MIN });
    expect(timerTimes(1000 * MIN, 970 * MIN, 60, 0)).toEqual({ askAt: (40 * MIN) / 60, alertAt: (45 * MIN) / 60 });   // demo clock 60x
  });
  it("a trip started after its deadline is asked 10 min after the start", async () => {
    const { timerTimes } = await import("../safetyTimer");
    expect(timerTimes(1000 * MIN, 1020 * MIN, 1, 0).askAt).toBe(10 * MIN);
  });
});

describe("Bluetooth packet codes", () => {
  it("round-trips every type and desk through the plugin's 2-bit codes", async () => {
    const { BleMeshTransport } = await import("../ble");
    for (const type of ["danger", "medical", "unsure", "ack"] as const) {
      for (const to of ["police", "hospital", "contact", ...(type === "ack" ? [] : ["fire"] as const)] as const) {
        const p = { id: 4000000000, type, to, lat: 28.570512, lon: 77.322934, ts: 1792965886, hop: 2, ttl: 5 };
        const w = BleMeshTransport.wire(p);
        expect(w.type).toBeGreaterThanOrEqual(0);
        expect(w.to).toBeGreaterThanOrEqual(0);
        expect(BleMeshTransport.unwire(w).packet).toEqual(p);
      }
    }
    expect(BleMeshTransport.unwire({ id: 1, type: 3, to: 3, ttl: 5, hop: 1, lat: 0, lon: 0, ts: 0 })).toMatchObject({ to: "test", packet: null });
    expect(BleMeshTransport.unwire({ id: 1, type: 2, to: 3, ttl: 5, hop: 1, lat: 0, lon: 0, ts: 0 }).packet).toMatchObject({ to: "fire", type: "unsure" });
  });
});

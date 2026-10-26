// The help escalation ladder (spec §9, UPGRADE §8 "reach whatever you can"):
//   1. the phone reaches the dispatch server -> send directly;  2. else -> into the mesh (real BLE when
//      MESH_REAL is on and running, else the simulated mesh) towards a gateway;
//   3. desks in order (config `dispatch.ladder`: police first for danger, hospital first for a doctor,
//      then the fire station); no acknowledgement within the step time -> the next one;
//   4. last step: the nearest OPEN place with people (24 h pharmacy, fuel, hotel). It cannot receive an
//      alert, so the app says "Not sure" and offers "Take me there" and "Call".
// Plain statuses only: Sending… -> Passed on -> Help is aware (never without an acknowledgement), or Not
// sure. Every step is logged for the Demo drawer. After the last step it keeps listening for a late answer.
import { CONFIG } from "../config";
import type { Desk, Dispatch, MeshTransport, SosPacket, SosType } from "./types";

export type HelpStatus = "sending" | "passed_on" | "aware" | "not_sure";
export type HelpTarget = Exclude<Desk, "contact"> | "place";
export interface HelpState {
  id: number; type: SosType; target: HelpTarget; step: number; steps: number; escalated: boolean; status: HelpStatus;
  via: "direct" | "mesh" | null; peers: number; log: string[];
}

export interface LadderDeps { dispatch: Dispatch; mesh: MeshTransport; forceMesh?: () => boolean; cfg?: typeof CONFIG.dispatch; stepS?: () => number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DESK_WORD: Record<HelpTarget, string> = { police: "police desk", hospital: "hospital desk", fire: "fire station desk", place: "open place nearby" };

export function newSosId(): number {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0] || 1;
}

/** Runs one help request. `stop()` ends it (a new request, or the app closing it). */
export function runLadder(d: LadderDeps, type: SosType, at: { lat: number; lon: number }, onState: (s: HelpState) => void) {
  const cfg = d.cfg ?? CONFIG.dispatch;
  const id = newSosId();
  const desks = (cfg.ladder[type] ?? ["police", "hospital", "fire"]) as HelpTarget[];
  const order: HelpTarget[] = [...desks, "place"];
  let stopped = false, acked = false, anyDirect = false;
  let state: HelpState = { id, type, target: order[0], step: 0, steps: order.length, escalated: false, status: "sending", via: null, peers: 0, log: [] };
  const emit = (patch: Partial<HelpState>) => { state = { ...state, ...patch }; if (!stopped) onState(state); };
  const log = (m: string) => emit({ log: [...state.log, m] });
  const unsub = d.mesh.onReceive((p) => { if (p.type === "ack" && p.id === id) acked = true; });
  const checkAck = async () => { if (!acked && anyDirect && (await d.dispatch.acked(String(id)))) acked = true; return acked; };

  const done = (async () => {
    for (let step = 0; step < order.length && !stopped; step++) {
      const to = order[step];
      if (step > 0) log(`${DESK_WORD[order[step - 1]]}: no answer. Trying ${DESK_WORD[to]}.`);
      if (to === "place") {                                   // cannot be alerted: go where people are
        emit({ target: to, step, escalated: true, status: "not_sure" });
        break;
      }
      emit({ target: to, step, escalated: step > 0, status: "sending", via: null });
      const ts = Math.round(Date.now() / 1000);
      const direct = !d.forceMesh?.() && (await d.dispatch.reachable())
        && (await d.dispatch.send({ id: String(id), type, to, lat: at.lat, lon: at.lon, ts, via: "direct", hops: 0 }));
      if (stopped) break;
      if (direct) { anyDirect = true; emit({ status: "passed_on", via: "direct" }); log(`Sent to the ${DESK_WORD[to]} directly.`); }
      else {
        const p: SosPacket = { id, type, to, lat: at.lat, lon: at.lon, ts, hop: 0, ttl: CONFIG.mesh.ttl };
        d.mesh.broadcast(p);
        const peers = d.mesh.status().peers;
        emit({ status: peers > 0 ? "passed_on" : "sending", via: "mesh", peers });
        log(`No server link: sent into the ${d.mesh.status().mode} mesh for the ${DESK_WORD[to]} (${peers} phone(s) in reach).`);
      }
      const end = Date.now() + (d.stepS?.() ?? cfg.ackTimeoutS) * 1000;
      while (!stopped && Date.now() < end && !(await checkAck())) {
        await sleep(cfg.pollMs);
        if (state.via === "mesh") { const peers = d.mesh.status().peers; if (peers !== state.peers) emit({ peers, status: peers > 0 ? "passed_on" : state.status }); }
      }
      if (acked) { emit({ status: "aware" }); log(`The ${DESK_WORD[to]} acknowledged.`); return state; }
    }
    if (stopped) return state;
    if (state.status !== "not_sure") emit({ status: "not_sure" });
    while (!stopped && !(await checkAck())) await sleep(cfg.pollMs);       // a late answer still counts
    if (acked) { emit({ status: "aware" }); log("A desk acknowledged after all."); }
    return state;
  })().finally(unsub);

  return { id, done, stop: () => { stopped = true; unsub(); } };
}

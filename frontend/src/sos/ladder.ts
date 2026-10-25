// The help escalation ladder (spec §9):
//   1. phone reaches the dispatch server -> send directly;  2. else -> into the mesh;
//   3. ask desks in order (config `dispatch.ladder`); no acknowledgement within `ackTimeoutS` -> next desk;
//   4. plain statuses: Sending… -> Passed on -> Help is aware, or Not sure when nobody answered.
// After the last desk it keeps listening, so a late acknowledgement still turns into "Help is aware".
import { CONFIG } from "../config";
import type { Desk, Dispatch, MeshTransport, SosPacket, SosType } from "./types";

export type HelpStatus = "sending" | "passed_on" | "aware" | "not_sure";
export interface HelpState { id: number; type: SosType; target: Desk; step: number; escalated: boolean; status: HelpStatus; via: "direct" | "mesh" | null }

export interface LadderDeps { dispatch: Dispatch; mesh: MeshTransport; forceMesh?: () => boolean; cfg?: typeof CONFIG.dispatch }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function newSosId(): number {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0] || 1;
}

/** Runs one help request. `stop()` ends it (a new request, or the app closing it). */
export function runLadder(d: LadderDeps, type: SosType, at: { lat: number; lon: number }, onState: (s: HelpState) => void) {
  const cfg = d.cfg ?? CONFIG.dispatch;
  const id = newSosId();
  const order = cfg.ladder[type] ?? ["police", "hospital"];
  let stopped = false, acked = false, anyDirect = false;
  let state: HelpState = { id, type, target: order[0], step: 0, escalated: false, status: "sending", via: null };
  const emit = (patch: Partial<HelpState>) => { state = { ...state, ...patch }; if (!stopped) onState(state); };
  const unsub = d.mesh.onReceive((p) => { if (p.type === "ack" && p.id === id) acked = true; });

  const checkAck = async () => { if (!acked && anyDirect && (await d.dispatch.acked(String(id)))) acked = true; return acked; };

  const done = (async () => {
    for (let step = 0; step < order.length && !stopped; step++) {
      const to = order[step];
      emit({ target: to, step, escalated: step > 0, status: "sending", via: null });
      const ts = Math.round(Date.now() / 1000);
      const direct = !d.forceMesh?.() && (await d.dispatch.reachable())
        && (await d.dispatch.send({ id: String(id), type, to, lat: at.lat, lon: at.lon, ts, via: "direct", hops: 0 }));
      if (stopped) break;
      if (direct) { anyDirect = true; emit({ status: "passed_on", via: "direct" }); }
      else {
        const p: SosPacket = { id, type, to, lat: at.lat, lon: at.lon, ts, hop: 0, ttl: CONFIG.mesh.ttl };
        d.mesh.broadcast(p);
        emit({ status: d.mesh.status().peers > 0 ? "passed_on" : "sending", via: "mesh" });
      }
      const end = Date.now() + cfg.ackTimeoutS * 1000;
      while (!stopped && Date.now() < end && !(await checkAck())) await sleep(cfg.pollMs);
      if (acked) { emit({ status: "aware" }); return state; }
    }
    if (stopped) return state;
    emit({ status: "not_sure" });
    while (!stopped && !(await checkAck())) await sleep(cfg.pollMs);       // a late answer still counts
    if (acked) emit({ status: "aware" });
    return state;
  })().finally(unsub);

  return { id, done, stop: () => { stopped = true; unsub(); } };
}

// One help service for the whole app: the dispatch client, the mesh, the running help request and
// the safety timer. Screens subscribe; closing the Help sheet does not stop a request.
import { Preferences } from "@capacitor/preferences";
import { useEffect, useState } from "react";
import { CONFIG } from "../config";
import { httpDispatch } from "./dispatch";
import { BleMeshTransport } from "./ble";
import { runLadder, type HelpState } from "./ladder";
import { SimulatedMeshTransport } from "./mesh";
import type { MeshTransport, SosType } from "./types";

let url = CONFIG.dispatch.defaultUrl;
Preferences.get({ key: "nw.dispatchUrl" }).then(({ value }) => { if (value) url = value; }).catch(() => {});

export const dispatch = httpDispatch(() => url);
export const mesh = new SimulatedMeshTransport(dispatch);
export const ble = new BleMeshTransport(dispatch);
export const demoFlags = { forceMesh: false };           // Demo: pretend the phone has no signal for help

// ---- MESH_REAL: real Bluetooth when it is on and running, else the simulated mesh -----------------
export const meshMode = { real: CONFIG.mesh.realDefault };
const activeMesh = (): MeshTransport => (meshMode.real && ble.running ? ble : mesh);
export const meshTransport: MeshTransport = {
  broadcast: (p) => activeMesh().broadcast(p),
  onReceive: (cb) => { const a = mesh.onReceive(cb), b = ble.onReceive(cb); return () => { a(); b(); }; },
  status: () => activeMesh().status(),
};

/** Switch the real Bluetooth relay on/off. Returns null, or why it could not start (then: simulated mesh). */
export async function setRealBluetooth(on: boolean, words: { title: string; text: string }): Promise<string | null> {
  Preferences.set({ key: "nw.meshReal", value: on ? "1" : "0" }).catch(() => {});
  if (!on) { meshMode.real = false; await ble.stop(); return null; }
  try {
    await ble.start(words);
    meshMode.real = true;
    return null;
  } catch (e) {
    meshMode.real = false;
    return (e as Error)?.message ?? String(e);
  }
}
/** At start-up: switch it back on if it was on. */
export async function restoreRealBluetooth(words: { title: string; text: string }): Promise<void> {
  const { value } = await Preferences.get({ key: "nw.meshReal" }).catch(() => ({ value: null }));
  if (value === "1" && BleMeshTransport.available()) await setRealBluetooth(true, words);
}

export const getDispatchUrl = () => url;
export function setDispatchUrl(u: string): void {
  url = u.trim() || CONFIG.dispatch.defaultUrl;
  Preferences.set({ key: "nw.dispatchUrl", value: url }).catch(() => {});
}

// ---- the running help request --------------------------------------------------------------------
let current: HelpState | null = null;
let stopCurrent: (() => void) | null = null;
const subs = new Set<(s: HelpState | null) => void>();
const set = (s: HelpState | null) => { current = s; subs.forEach((f) => f(s)); };

export function askForHelp(type: SosType, at: { lat: number; lon: number }): void {
  stopCurrent?.();
  const run = runLadder({ dispatch, mesh: meshTransport, forceMesh: () => demoFlags.forceMesh }, type, at, set);
  stopCurrent = run.stop;
}

export function useHelp(): HelpState | null {
  const [s, setS] = useState(current);
  useEffect(() => { subs.add(setS); return () => { subs.delete(setS); }; }, []);
  return s;
}

/** The safety timer's alert to the (simulated) Contact desk: directly, else through the mesh. */
export async function alertContact(at: { lat: number; lon: number }): Promise<void> {
  const id = String(Math.floor(Math.random() * 2 ** 31) + 1);
  const ts = Math.round(Date.now() / 1000);
  if (!demoFlags.forceMesh && (await dispatch.reachable()) && (await dispatch.send({ id, type: "unsure", to: "contact", ...at, ts, via: "direct", hops: 0 }))) return;
  meshTransport.broadcast({ id: Number(id), type: "unsure", to: "contact", ...at, ts, hop: 0, ttl: CONFIG.mesh.ttl });
}

/** Map link for the text message (OpenStreetMap; no account, no tracking). */
export const mapLink = (lat: number, lon: number) =>
  `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=17/${lat.toFixed(5)}/${lon.toFixed(5)}`;
export const smsHref = (body: string) => `sms:?body=${encodeURIComponent(body)}`;

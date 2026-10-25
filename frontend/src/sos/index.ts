// One help service for the whole app: the dispatch client, the mesh, the running help request and
// the safety timer. Screens subscribe; closing the Help sheet does not stop a request.
import { Preferences } from "@capacitor/preferences";
import { useEffect, useState } from "react";
import { CONFIG } from "../config";
import { httpDispatch } from "./dispatch";
import { runLadder, type HelpState } from "./ladder";
import { SimulatedMeshTransport } from "./mesh";
import type { SosType } from "./types";

let url = CONFIG.dispatch.defaultUrl;
Preferences.get({ key: "nw.dispatchUrl" }).then(({ value }) => { if (value) url = value; }).catch(() => {});

export const dispatch = httpDispatch(() => url);
export const mesh = new SimulatedMeshTransport(dispatch);
export const demoFlags = { forceMesh: false };           // Demo: pretend the phone has no signal for help

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
  const run = runLadder({ dispatch, mesh, forceMesh: () => demoFlags.forceMesh }, type, at, set);
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
  mesh.broadcast({ id: Number(id), type: "unsure", to: "contact", ...at, ts, hop: 0, ttl: CONFIG.mesh.ttl });
}

/** Map link for the text message (OpenStreetMap; no account, no tracking). */
export const mapLink = (lat: number, lon: number) =>
  `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=17/${lat.toFixed(5)}/${lon.toFixed(5)}`;
export const smsHref = (body: string) => `sms:?body=${encodeURIComponent(body)}`;

// HTTP client for the demo dispatch server (server/server.js). In the APK, CapacitorHttp sends these
// natively, so plain http:// to the laptop on the same Wi-Fi works.
import { CONFIG } from "../config";
import type { Dispatch, SosRequest } from "./types";

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

export function httpDispatch(url: () => string): Dispatch {
  const base = () => url().replace(/\/+$/, "");
  const c = CONFIG.dispatch;
  return {
    reachable: () => withTimeout(fetch(`${base()}/health`).then((r) => r.ok), c.reachTimeoutMs, false),
    send: (r: SosRequest) => withTimeout(
      fetch(`${base()}/sos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r) }).then((x) => x.ok),
      c.sendTimeoutMs, false),
    acked: (id: string) => withTimeout(
      fetch(`${base()}/sos/${encodeURIComponent(id)}`).then(async (x) => x.ok && Boolean(((await x.json()) as { acked?: boolean }).acked)),
      c.sendTimeoutMs, false),
  };
}

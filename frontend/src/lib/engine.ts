// The UI's only way to the engine: a Web Worker running src/engine/worker.ts on the bundled data.
import type { EngineApi, Pushed } from "../engine/worker";

type Result<K extends keyof EngineApi> = Awaited<ReturnType<EngineApi[K]>>;

const worker = new Worker(new URL("../engine/worker.ts", import.meta.url), { type: "module" });
const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
const listeners = new Set<(m: Pushed) => void>();
let seq = 0;

worker.onmessage = (ev: MessageEvent<{ id?: number; result?: unknown; error?: string; push?: Pushed }>) => {
  const d = ev.data;
  if (d.push) { listeners.forEach((f) => f(d.push!)); return; }
  const w = waiting.get(d.id!);
  if (!w) return;
  waiting.delete(d.id!);
  if (d.error !== undefined) w.fail(new Error(d.error)); else w.ok(d.result);
};

export function call<K extends keyof EngineApi>(op: K, ...args: Parameters<EngineApi[K]>): Promise<Result<K>> {
  return new Promise((ok, fail) => {
    const id = ++seq;
    waiting.set(id, { ok: ok as (v: unknown) => void, fail });
    worker.postMessage({ id, op, args });
  });
}

/** Views and status the engine pushes on every tick. Returns an unsubscribe function. */
export function listen(f: (m: Pushed) => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

export type AppConfig = Result<"init">;

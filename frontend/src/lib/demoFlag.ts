// "Demo time" chip: on while the demo moves time or location (app clock away from real time, or fake GPS).
import { useEffect, useState } from "react";

let on = false;
const subs = new Set<(v: boolean) => void>();
export function setDemoActive(v: boolean): void { if (v !== on) { on = v; subs.forEach((f) => f(v)); } }
export function useDemoActive(): boolean {
  const [v, setV] = useState(on);
  useEffect(() => { subs.add(setV); return () => { subs.delete(setV); }; }, []);
  return v;
}

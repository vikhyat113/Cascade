// Night-safety heat by hour (UPGRADE §3): an ESTIMATE per 250 m cell with streets, from the
// (synthetic) incident grid for that hour, street lighting and isolation. Shown as "Safety heat";
// the Demo drawer says what it is made of.
import { CONFIG } from "../config";
import type { World } from "./world";

const W_INC = 0.45, W_LIGHT = 0.35, W_ISO = 0.2;

/** [south, west, north, east, value 0..1 (higher = less safe)] for every cell with streets. */
export function heatmap(w: World, hour: number): number[][] {
  const risk = w.incRisk.get(hour) ?? w.incRisk.get(CONFIG.risk.nightHours[0]) ?? null;
  const len = new Map<number, number>(), light = new Map<number, number>(), iso = new Map<number, number>();
  for (let e = 0; e < w.m; e++) {
    const c = w.cell[e], L = w.elen[e];
    len.set(c, (len.get(c) ?? 0) + L);
    light.set(c, (light.get(c) ?? 0) + L * (w.lightLo[e] + w.lightHi[e]) / 2);
    iso.set(c, (iso.get(c) ?? 0) + L * w.isoBase[e]);
  }
  const g = w.incGrid, out: number[][] = [];
  for (const [c, L] of len) {
    if (L < 40) continue;
    const i = c % g.nx, j = Math.floor(c / g.nx);
    const x0 = g.xmin + i * g.size, y0 = g.ymin + j * g.size;
    const inc = risk ? Math.min(1, risk[c] ?? 0) : 0.3;
    const v = W_INC * inc + W_LIGHT * (light.get(c)! / L) + W_ISO * (iso.get(c)! / L);
    out.push([w.proj.lat(y0), w.proj.lon(x0), w.proj.lat(y0 + g.size), w.proj.lon(x0 + g.size), Math.round(v * 100) / 100]);
  }
  return out;
}

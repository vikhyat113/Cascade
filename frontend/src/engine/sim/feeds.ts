// Live feed simulator (spec §7.2): turns the simulator's ground truth into Facts with random delay,
// dropouts, partial coverage and short outage bursts. A switched-off source (or a phone with no
// network) simply stops reporting: its facts age KNOWN -> PROBABLE -> OUTDATED -> UNKNOWN.
import { LIVE_SOURCES, SOURCES, type SourceId } from "../../config";
import type { Fact } from "../freshness";
import type { State } from "../state";
import { tripsFor } from "../transit";

const HOUR_SPEED: Record<number, number> = { 18: 0.6, 19: 0.62, 20: 0.7, 21: 0.8, 22: 0.84, 23: 0.92, 0: 0.97, 1: 1, 2: 1, 3: 1, 4: 0.97, 5: 0.9, 6: 0.8, 7: 0.7 };
const RAIN_SPEED: Record<string, number> = { none: 1, light: 0.92, moderate: 0.82, heavy: 0.68 };
const RAIN_MM: Record<string, number> = { none: 0, light: 1, moderate: 4, heavy: 12 };

export class FeedSimulator {
  constructor(private s: State, private bursts = true) {}

  tick(dtS: number): void {
    const s = this.s, now = s.now();
    this.evolveTruth(now, dtS);
    for (const sid of LIVE_SOURCES) {
      const src = s.sources[sid], cfg = SOURCES[sid];
      if (!s.liveOn(sid)) continue;
      if (sid === "traffic" && s.realTrafficOn()) { this.realTraffic(); continue; }
      if (src.burstUntil && now < src.burstUntil) continue;
      if (s.rng.next() < (cfg.dropout ?? 0)) continue;
      if (this.bursts && s.rng.next() < 0.003) { src.burstUntil = now + s.rng.uniform(60, 200) * 1000; continue; }
      const obs = now - s.rng.uniform(0, cfg.maxDelayS ?? 0) * 1000;
      this.emit(sid, obs, now);
      src.lastOk = src.lastOk === null ? obs : Math.max(src.lastOk, obs);
    }
  }

  /** Run feeds for `seconds` before the first plan so live facts exist; the clock returns afterwards. */
  warmup(seconds: number, step = 20): void {
    const start = this.s.now();
    this.s.clock.set({ time: start - seconds * 1000 });
    for (let t = 0; t < seconds; t += step) { this.s.clock.advance(step); this.tick(step); }
    this.s.clock.set({ time: start });
  }

  private fact(sid: SourceId, key: string, value: unknown, obs: number, synthetic = SOURCES[sid].synthetic, note?: string): Fact {
    const c = SOURCES[sid];
    return { key, value, source: sid, synthetic, observedAt: obs, ttlS: c.ttlS, reliability: c.reliability, kind: "observed", note: note ?? null };
  }

  private activeTrips(now: number) {
    return tripsFor(this.s.world, now, this.s.pretendNightBuses).trips.filter((t) => t.times[0] >= now - 45 * 60000 && t.times[0] <= now + 60 * 60000);
  }

  private evolveTruth(now: number, dtS: number): void {
    const s = this.s, tr = s.truth, w = s.world;
    for (const trip of this.activeTrips(now)) {
      let d = tr.tripDelay.get(trip.id) ?? Math.max(-60, Math.min(300, s.rng.normal(40, 60)));
      d += s.rng.normal(0, 6) * Math.sqrt(Math.max(dtS, 1) / 60);
      tr.tripDelay.set(trip.id, Math.max(-60, Math.min(900, d)));
    }
    // heavy rain floods low spots after ~10 minutes
    if ((tr.rain === "moderate" || tr.rain === "heavy") && tr.rainSince !== null && now - tr.rainSince >= 600000 && !tr.closures.has("flood") && w.floodEdges.length) {
      const e = w.floodEdges[0];
      tr.closures.set("flood", { name: "Waterlogged streets", reason: "water on the road after heavy rain", kind: "waterlogging", edges: [...w.floodEdges],
        lat: w.proj.lat(w.emy[e]), lon: w.proj.lon(w.emx[e]), since: now });
    } else if (!tr.rain && tr.closures.has("flood")) {
      tr.lifted.set("flood", [now, tr.closures.get("flood")!]);
      tr.closures.delete("flood");
    }
  }

  /** HERE traffic flow (UPGRADE §9): real readings for the cells HERE covers, observed when HERE says.
   *  Cells it does not cover get no reading (they become "not sure"), never a simulated one. */
  private realTraffic(): void {
    const s = this.s, r = s.realTraffic!, c = SOURCES.traffic;
    for (const [cell, f] of r.cells) {
      s.put({ key: `traffic:cell:${cell}`, value: { speed_factor: f }, source: "traffic", synthetic: false, observedAt: r.at,
        ttlS: s.ttlOf("traffic"), reliability: c.reliability, kind: "observed", note: "HERE traffic flow" });
    }
    s.sources.traffic.lastOk = r.at;
  }

  private emit(sid: SourceId, obs: number, now: number): void {
    const s = this.s, w = s.world, tr = s.truth, cfg = SOURCES[sid];
    if (sid === "traffic") {
      const h = w.city.hour(now);
      for (const c of w.trafficCells) {
        if (s.rng.next() > (cfg.coverage ?? 1)) continue;
        let f = (HOUR_SPEED[h] ?? 0.75) * w.trafficBias[c] * (tr.accidents.get(c) ?? 1) * (RAIN_SPEED[tr.rain ?? "none"] ?? 1);
        f *= 1 + s.rng.normal(0, 0.03);
        s.put(this.fact(sid, `traffic:cell:${c}`, { speed_factor: Math.round(Math.max(0.1, f) * 1000) / 1000 }, obs));
      }
    } else if (sid === "transit_realtime") {
      for (const trip of this.activeTrips(now)) {
        if (s.rng.next() > (cfg.coverage ?? 1)) continue;
        const delay = (tr.tripDelay.get(trip.id) ?? 0) + (tr.scheduleConflicts.get(trip.routeId) ?? 0);
        s.put(this.fact(sid, `transit:rt:${trip.id}`, { delay_s: Math.round(delay), cancelled: tr.cancelledTrips.has(trip.id), route: trip.routeId }, obs));
      }
    } else if (sid === "closures") {
      for (const [id, c] of tr.closures) s.put(this.fact(sid, `closure:${id}`, { active: true, name: c.name, reason: c.reason, kind: c.kind, edges: c.edges, lat: c.lat, lon: c.lon }, obs));
      for (const [id, [at, c]] of tr.lifted) {
        s.put(this.fact(sid, `closure:${id}`, { active: false, name: c.name, reason: "lifted" }, obs));
        if (now - at > 1800000) tr.lifted.delete(id);
      }
    } else if (sid === "weather") {
      const real = s.realWeather;
      if (tr.rain) {
        // demo rain is a simulated observation (labelled synthetic)
        s.put(this.fact(sid, "weather:now", { rain_class: tr.rain, rain_mm: RAIN_MM[tr.rain], precip_prob: 100 }, obs, true, "simulated rain (demo)"));
      } else if (real && real.observedAt != null && now - real.observedAt >= 0 && now - real.observedAt < 1800000) {   // only when the app clock is near real time
        s.put({ ...real, key: "weather:now", observedAt: Math.max(real.observedAt, obs - 60000) });   // real Open-Meteo reading
      } else {
        const row = w.weatherRows.get(w.city.hourKey(now)) ?? {};
        s.put(this.fact(sid, "weather:now", { ...row, rain_class: null }, obs, true, "simulated reading around the saved forecast"));
      }
    }
  }
}

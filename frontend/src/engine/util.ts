// Small shared helpers: seeded randomness and a local metric projection.

/** mulberry32: small, fast, seeded PRNG (scenarios must replay identically). */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(a: number, b: number): number { return a + (b - a) * this.next(); }
  normal(mu = 0, sd = 1): number {
    const u = Math.max(1e-12, this.next());
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  lognormal(mu: number, sd: number): number { return Math.exp(this.normal(mu, sd)); }
  pick<T>(xs: T[]): T { return xs[Math.floor(this.next() * xs.length)]; }
}

/** Equirectangular projection around the city centre (metres); < 1% error over a few km. */
export class Proj {
  kx: number;
  ky = 110540;
  constructor(public lat0: number, public lon0: number) { this.kx = 111320 * Math.cos((lat0 * Math.PI) / 180); }
  x(lon: number): number { return (lon - this.lon0) * this.kx; }
  y(lat: number): number { return (lat - this.lat0) * this.ky; }
  lat(y: number): number { return this.lat0 + y / this.ky; }
  lon(x: number): number { return this.lon0 + x / this.kx; }
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const round = (v: number, d = 0) => { const k = 10 ** d; return Math.round(v * k) / k; };

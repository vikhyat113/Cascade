// Moon light for the night, COMPUTED (not measured), for the Layers sheet (UPGRADE §3).
// Low-precision formulas after SunCalc (Vladimir Agafonkin, BSD-2-Clause): illuminated fraction and
// the moon's altitude for a place and time. Accurate to about a degree / a few percent: enough to say
// "bright moon, up" or "no moon". The `changes` branch's fallback gave a fixed 35° altitude; not ported.

const RAD = Math.PI / 180, DAY_MS = 86400000, J1970 = 2440588, J2000 = 2451545, OBLIQ = RAD * 23.4397;

const toDays = (ms: number) => ms / DAY_MS - 0.5 + J1970 - J2000;
const rightAscension = (l: number, b: number) => Math.atan2(Math.sin(l) * Math.cos(OBLIQ) - Math.tan(b) * Math.sin(OBLIQ), Math.cos(l));
const declination = (l: number, b: number) => Math.asin(Math.sin(b) * Math.cos(OBLIQ) + Math.cos(b) * Math.sin(OBLIQ) * Math.sin(l));
const siderealTime = (d: number, lw: number) => RAD * (280.16 + 360.9856235 * d) - lw;
const altitudeOf = (H: number, phi: number, dec: number) => Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));

function sunCoords(d: number) {
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

function moonCoords(d: number) {
  const L = RAD * (218.316 + 13.176396 * d), M = RAD * (134.963 + 13.064993 * d), F = RAD * (93.272 + 13.22935 * d);
  const l = L + RAD * 6.289 * Math.sin(M), b = RAD * 5.128 * Math.sin(F);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: 385001 - 20905 * Math.cos(M) };
}

export interface MoonLight { fraction: number; altitudeDeg: number; up: boolean; level: "bright" | "some" | "none"; computed: true }

/** Illuminated fraction (0..1), altitude, and a plain level: light reaching the street from the moon. */
export function moonLight(ms: number, lat: number, lon: number): MoonLight {
  const d = toDays(ms);
  const s = sunCoords(d), m = moonCoords(d);
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(149598000 * Math.sin(phi), m.dist - 149598000 * Math.cos(phi));
  const fraction = (1 + Math.cos(inc)) / 2;
  const alt = altitudeOf(siderealTime(d, RAD * -lon) - m.ra, RAD * lat, m.dec) / RAD;
  const light = alt > 0 ? fraction * Math.sin(alt * RAD) : 0;
  return { fraction: Math.round(fraction * 1000) / 1000, altitudeDeg: Math.round(alt * 10) / 10, up: alt > 0,
    level: light >= 0.35 ? "bright" : light >= 0.08 ? "some" : "none", computed: true };
}

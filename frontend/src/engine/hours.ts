// Small OSM `opening_hours` parser for the common patterns ("24/7", "Mo-Fr 08:30-17:30",
// "Mo-Su 06:00-14:00,16:00-21:00", ranges past midnight, "Sa,Su off", several rules with ";").
// Anything else returns null: the hours are then UNKNOWN, never guessed.

const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

export interface OpeningHours {
  raw: string;
  always: boolean;
  days: Map<number, [number, number][]>;   // weekday (Mo=0) -> [startMin, endMin], end may exceed 1440
}

function parseDays(spec: string): Set<number> | null {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/.exec(part.trim());
    if (!m) return null;
    const a = DAYS.indexOf(m[1]);
    const b = m[2] ? DAYS.indexOf(m[2]) : a;
    for (let i = a; ; i = (i + 1) % 7) { out.add(i); if (i === b) break; }
  }
  return out;
}

function parseTimes(spec: string): [number, number][] | null {
  const out: [number, number][] = [];
  for (const part of spec.split(",")) {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(part.trim());
    if (!m) return null;
    const [h1, m1, h2, m2] = m.slice(1).map(Number);
    if (h1 > 24 || h2 > 48 || m1 > 59 || m2 > 59) return null;
    const s = h1 * 60 + m1;
    let e = h2 * 60 + m2;
    if (e <= s) e += 1440;                     // 18:00-02:00 runs past midnight
    out.push([s, e]);
  }
  return out;
}

export function parseHours(raw: string | null | undefined): OpeningHours | null {
  if (!raw || typeof raw !== "string") return null;
  const text = raw.trim();
  if (["24/7", "Mo-Su 00:00-24:00", "00:00-24:00"].includes(text)) return { raw, always: true, days: new Map() };
  const oh: OpeningHours = { raw, always: false, days: new Map() };
  for (const rule of text.split(";").map((r) => r.trim()).filter(Boolean)) {
    if (rule.startsWith("PH")) continue;     // public holidays: unknowable here
    const tok = rule.split(/\s+/);
    let days: Set<number> | null;
    let rest: string;
    if (tok.length === 1) { days = new Set([0, 1, 2, 3, 4, 5, 6]); rest = tok[0]; }
    else if (tok.length === 2) { days = parseDays(tok[0]); rest = tok[1]; if (!days) return null; }
    else return null;
    if (rest === "off" || rest === "closed") { for (const d of days) oh.days.set(d, []); continue; }
    const times = rest === "24/7" ? [[0, 1440] as [number, number]] : parseTimes(rest);
    if (!times) return null;
    for (const d of days) oh.days.set(d, [...times]);
  }
  if (!oh.days.size) return null;
  if ([0, 1, 2, 3, 4, 5, 6].every((d) => { const r = oh.days.get(d); return r && r.length === 1 && r[0][0] === 0 && r[0][1] === 1440; })) oh.always = true;
  return oh;
}

/** Open at local weekday (Mo=0) and minute of day? */
export function isOpen(oh: OpeningHours, weekday: number, minute: number): boolean {
  if (oh.always) return true;
  for (const [s, e] of oh.days.get(weekday) ?? []) if (s <= minute && minute < e) return true;
  for (const [s, e] of oh.days.get((weekday + 6) % 7) ?? []) if (e > 1440 && minute < e - 1440) { void s; return true; }
  return false;
}

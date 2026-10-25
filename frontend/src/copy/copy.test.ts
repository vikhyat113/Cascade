// UI_SPEC §3 "Enforce it": runs before every build (npm run build) and fails it on
// banned words, over-long strings, or Hindi copy that drifts from English.
import { describe, expect, it } from "vitest";
import banned from "./banned.json";
import en from "./en";
import hi from "./hi";

const PLACEHOLDER = /\{[a-z]+\}/g;

export function words(s: string): string[] {
  return s.replace(PLACEHOLDER, "X").replace(/[.,:;!?…()]/g, " ").trim().split(/\s+/).filter(Boolean);
}

function hasBanned(s: string): string[] {
  const low = s.toLowerCase();
  return banned.banned.filter((w) => new RegExp(`(^|[^a-z])${w.replace(/[-]/g, "\\-")}([^a-z]|$)`).test(low));
}

const limits = banned.limits as Record<string, number>;

describe("copy deck (en.ts)", () => {
  const entries = Object.entries(en) as [string, string][];

  it("uses no banned words", () => {
    const bad = entries.flatMap(([k, v]) => hasBanned(v).map((w) => `${k}: "${v}" contains "${w}"`));
    expect(bad).toEqual([]);
  });

  it("keeps every string within its length limit", () => {
    const bad = entries.flatMap(([k, v]) => {
      const kind = k.split(".")[0];
      const max = limits[kind];
      if (max === undefined) return [`${k}: unknown key prefix "${kind}"`];
      const n = words(v).length;
      return n > max ? [`${k}: ${n} words > ${max} ("${v}")`] : [];
    });
    expect(bad).toEqual([]);
  });

  it("can join any two reasons within the explanation limit", () => {
    const reasons = entries.filter(([k]) => k.startsWith("reason.")).map(([, v]) => words(v).length);
    const longest = [...reasons].sort((a, b) => b - a);
    expect(longest[0] + longest[1]).toBeLessThanOrEqual(banned.reason_max_words);
  });
});

describe("copy deck (hi.ts)", () => {
  it("has every key, non-empty, with the same placeholders", () => {
    const bad: string[] = [];
    for (const [k, v] of Object.entries(en) as [keyof typeof en, string][]) {
      const h = hi[k];
      if (!h || !h.trim()) { bad.push(`${k}: missing`); continue; }
      const pe = (v.match(PLACEHOLDER) || []).sort().join(",");
      const ph = (h.match(PLACEHOLDER) || []).sort().join(",");
      if (pe !== ph) bad.push(`${k}: placeholders ${pe} vs ${ph}`);
    }
    expect(bad).toEqual([]);
  });

  it("stays short too (Hindi gets two extra words of slack)", () => {
    const bad = (Object.entries(hi) as [string, string][]).flatMap(([k, v]) => {
      const max = limits[k.split(".")[0]] + 2;
      return words(v).length > max ? [`${k}: "${v}"`] : [];
    });
    expect(bad).toEqual([]);
  });
});

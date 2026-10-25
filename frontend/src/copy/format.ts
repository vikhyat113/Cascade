// Pure word lookup (no React), shared by the UI and the engine's simple view.
import en, { type CopyKey } from "./en";
import hi from "./hi";

export type Lang = "en" | "hi";
const TABLES: Record<Lang, Record<CopyKey, string>> = { en, hi };

export function format(lang: Lang, key: CopyKey, params?: Record<string, string | number>): string {
  let s: string = TABLES[lang]?.[key] ?? en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export type { CopyKey };

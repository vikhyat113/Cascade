import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import en, { type CopyKey } from "./en";
import hi from "./hi";

export type Lang = "en" | "hi";
const TABLES: Record<Lang, Record<CopyKey, string>> = { en, hi };

function stored(): Lang {
  try {
    const v = localStorage.getItem("nw.lang");
    return v === "hi" ? "hi" : "en";
  } catch {
    return "en";
  }
}

export function format(lang: Lang, key: CopyKey, params?: Record<string, string | number>): string {
  let s: string = TABLES[lang][key] ?? en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (key: CopyKey, params?: Record<string, string | number>) => string };
const LangCtx = createContext<Ctx>({ lang: "en", setLang: () => {}, t: (k, p) => format("en", k, p) });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(stored);
  const value = useMemo<Ctx>(() => ({
    lang,
    setLang: (l) => {
      setLangState(l);
      try { localStorage.setItem("nw.lang", l); } catch { /* private mode */ }
      document.documentElement.lang = l;
    },
    t: (k, p) => format(lang, k, p),
  }), [lang]);
  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>;
}

export const useT = () => useContext(LangCtx);
export type { CopyKey };

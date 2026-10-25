import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { format, type CopyKey, type Lang } from "./format";

function stored(): Lang {
  try { return localStorage.getItem("nw.lang") === "hi" ? "hi" : "en"; } catch { return "en"; }
}

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (key: CopyKey, params?: Record<string, string | number>) => string };
const LangCtx = createContext<Ctx>({ lang: "en", setLang: () => {}, t: (k, p) => format("en", k, p) });

export function LangProvider({ children, onChange }: { children: ReactNode; onChange?: (l: Lang) => void }) {
  const [lang, setLangState] = useState<Lang>(stored);
  const value = useMemo<Ctx>(() => ({
    lang,
    setLang: (l) => {
      setLangState(l);
      try { localStorage.setItem("nw.lang", l); } catch { /* private mode */ }
      document.documentElement.lang = l;
      onChange?.(l);
    },
    t: (k, p) => format(lang, k, p),
  }), [lang, onChange]);
  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>;
}

export const useT = () => useContext(LangCtx);
export { format, type CopyKey, type Lang };

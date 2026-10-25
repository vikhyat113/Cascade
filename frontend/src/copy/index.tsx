import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { format, type CopyKey, type Lang } from "./format";

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (key: CopyKey, params?: Record<string, string | number>) => string };
const LangCtx = createContext<Ctx>({ lang: "en", setLang: () => {}, t: (k, p) => format("en", k, p) });

/** Language for the whole app. Saving it is the caller's job (`onChange`). */
export function LangProvider({ children, initial = "en", onChange }: { children: ReactNode; initial?: Lang; onChange?: (l: Lang) => void }) {
  const [lang, setLangState] = useState<Lang>(initial);
  const value = useMemo<Ctx>(() => ({
    lang,
    setLang: (l) => {
      setLangState(l);
      document.documentElement.lang = l;
      onChange?.(l);
    },
    t: (k, p) => format(lang, k, p),
  }), [lang, onChange]);
  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>;
}

export const useT = () => useContext(LangCtx);
export { format, type CopyKey, type Lang };

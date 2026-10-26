import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { LangProvider } from "./copy";
import { loadLang, saveLang } from "./lib/saved";
import "./index.css";

loadLang().then((lang) => {
  document.documentElement.lang = lang;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <LangProvider initial={lang} onChange={saveLang}>
        <App />
      </LangProvider>
    </StrictMode>,
  );
});

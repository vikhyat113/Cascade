import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LangProvider } from "../../copy";
import en from "../../copy/en";
import hi from "../../copy/hi";
import { SosButton } from "../SosButton";

const html = (lang: "en" | "hi") => renderToStaticMarkup(<LangProvider initial={lang}><SosButton onPress={() => {}} /></LangProvider>);

describe("SOS button", () => {
  it.each(["en", "hi"] as const)("has its label and a screen-reader name in %s", (lang) => {
    const h = html(lang);
    const words = lang === "en" ? en : hi;
    expect(h).toContain(words["label.sos"]);
    expect(h).toContain(`aria-label="${words["label.sosLong"]}"`);
    expect(h.startsWith("<button")).toBe(true);
  });
  it("is big, fixed top-right and above every sheet, dialog and drawer", () => {
    const h = html("en");
    for (const cls of ["fixed", "right-3", "h-14", "min-w-14", "z-[90]", "bg-help"]) expect(h).toContain(cls);
  });
});

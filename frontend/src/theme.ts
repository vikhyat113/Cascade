// All colours, sizes and spacing (spec §5). index.css maps these onto Tailwind tokens via CSS variables.
export const THEME = {
  color: {
    night: "#0a0f1e",
    surface: "#131b31",
    raised: "#1c2642",
    edge: "#2c3860",
    ink: "#f4f6ff",
    soft: "#c3cae6",          // secondary text, 9.6:1 on surface
    accent: "#8b7cff",        // the one accent: buttons, the way on the map
    accentInk: "#0a0f1e",
    good: "#34d399",
    warn: "#fbbf24",
    bad: "#f87171",
    help: "#e5484d",
    me: "#60a5fa",
    roadMajor: "#4a5a8c",     // bundled road network on the map
    roadMinor: "#232c4a",
  },
  size: {
    body: "1.0625rem",        // 17px
    key: "1.625rem",          // 26px
    huge: "2rem",             // 32px
    tap: "3rem",              // 48px minimum tap target
  },
  font: `system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Devanagari", "Nirmala UI", sans-serif`,
};

/** Push the theme into CSS variables (read by index.css / Tailwind). */
export function applyTheme(root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(THEME.color)) root.style.setProperty(`--nw-${k}`, v);
  for (const [k, v] of Object.entries(THEME.size)) root.style.setProperty(`--nw-size-${k}`, v);
  root.style.setProperty("--nw-font", THEME.font);
}

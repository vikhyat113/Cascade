// Icons + words + colour together (UI_SPEC §1.6). Emoji are light and render on cheap phones.
export const STEP_ICON: Record<string, string> = { walk: "🚶", wait: "⏳", bus: "🚌", metro: "🚇", cab: "🚕", done: "🏁" };
export const PLACE_ICON: Record<string, string> = {
  pharmacy: "💊", hospital: "🏥", police: "👮", food: "🍲", shop: "🛒", fuel: "⛽", atm: "🏧", help: "🆘",
};
export const SAFETY = {
  safe: { icon: "🟢", color: "text-good" },
  ok: { icon: "🟡", color: "text-warn" },
  careful: { icon: "🔴", color: "text-bad" },
} as const;
export const TIMING = {
  on_time: { icon: "✅", color: "text-good" },
  maybe_late: { icon: "⚠️", color: "text-warn" },
  too_late: { icon: "❌", color: "text-bad" },
} as const;
export const STATE = {
  open: { icon: "✅", color: "text-good" },
  maybe_open: { icon: "🟡", color: "text-warn" },
  not_sure: { icon: "❔", color: "text-soft" },
} as const;

export function Chevron({ dir = "right" }: { dir?: "right" | "left" | "down" | "up" }) {
  const r = { right: 0, down: 90, left: 180, up: 270 }[dir];
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" style={{ transform: `rotate(${r}deg)` }}>
      <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

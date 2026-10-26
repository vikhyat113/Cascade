/**
 * icons.tsx — compatibility shim; all icon logic is now in Icon.tsx.
 * Exports plain semantic records used by existing screens.
 * No emoji. Use Icon component for rendering.
 */
export { Icon, Chevron, STEP_TO_ICON, PLACE_TYPE_TO_ICON } from "./Icon";
export type { IconName } from "./Icon";
import type { IconName } from "./Icon";

// Semantic icon key maps (replaces emoji-based STEP_ICON / PLACE_ICON)
export const STEP_ICON: Record<string, IconName> = {
  walk: "walk", wait: "wait", bus: "bus", metro: "metro", cab: "cab", done: "done",
};
export const PLACE_ICON: Record<string, IconName> = {
  pharmacy: "medicine", hospital: "hospital", clinic: "hospital",
  police: "police", food: "food", restaurant: "food",
  shop: "landmark", fuel: "petrol-pump", atm: "atm", help: "sos",
};

// Safety / timing / state now return { iconName, color } — no emoji
export const SAFETY = {
  safe:    { iconName: "shield-check" as IconName,    color: "text-good" },
  ok:      { iconName: "shield-alert" as IconName,    color: "text-warn" },
  careful: { iconName: "shield-alert" as IconName,    color: "text-bad"  },
} as const;

export const TIMING = {
  on_time:    { iconName: "check-circle"    as IconName, color: "text-good" },
  maybe_late: { iconName: "alert-triangle"  as IconName, color: "text-warn" },
  too_late:   { iconName: "x-circle"        as IconName, color: "text-bad"  },
} as const;

export const STATE = {
  open:       { iconName: "check-circle"   as IconName, color: "text-good" },
  maybe_open: { iconName: "alert-triangle" as IconName, color: "text-warn" },
  not_sure:   { iconName: "info"           as IconName, color: "text-soft" },
} as const;

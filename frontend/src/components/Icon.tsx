/**
 * Icon.tsx — single source of truth for every icon in NightWay.
 * Inline SVG, 24x24 viewBox, stroke currentColor, strokeWidth 1.75,
 * round caps/joins, no fills except tiny dots. aria-hidden unless label given.
 * Never uses emoji or pictographic code points.
 */

export type IconName =
  | "medicine" | "food" | "hospital" | "police"
  | "search" | "locate" | "layers" | "menu" | "swap" | "close"
  | "chevron-left" | "chevron-right" | "chevron-up" | "chevron-down"
  | "map-pin" | "origin-dot" | "walk" | "car" | "bus" | "train"
  | "clock" | "shield-check" | "shield-alert" | "check-circle"
  | "alert-triangle" | "x-circle" | "road" | "highway" | "petrol-pump"
  | "lamp" | "lamp-off" | "barrier" | "moon" | "rain" | "thermometer"
  | "sos" | "share" | "info" | "settings" | "language" | "route-fork"
  | "flag" | "home" | "work" | "wait" | "cab" | "done"
  | "landmark" | "atm" | "metro" | "gap-warning" | "unknown-light";

const PATHS: Record<IconName, string> = {
  medicine: `<path d="M6 11h12M12 5v14M6 8l-2 3v6l2 3h12l2-3V11l-2-3H6z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  food: `<path d="M3 6v14M3 11h4c1.1 0 2-.9 2-2V4M17 4v16M17 4c0 0 4 1 4 5s-4 5-4 5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  hospital: `<path d="M3 9h18M3 15h18M9 3v18M15 3v18M3 3h18v18H3z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  police: `<path d="M12 2l2 5h5l-4 3 1.5 5L12 12l-4.5 3L9 10 5 7h5z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 22c-4-2-6-5-6-9v-1l6-2 6 2v1c0 4-2 7-6 9z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  search: `<circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="m16.5 16.5 4 4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  locate: `<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  layers: `<path d="M2 12l10-6 10 6-10 6-10-6z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M2 17l10 6 10-6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M2 7l10 6 10-6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  menu: `<path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  swap: `<path d="M7 16V8m0 0L4 11m3-3 3 3M17 8v8m0 0 3-3m-3 3-3-3" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  close: `<path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  "chevron-left": `<path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  "chevron-right": `<path d="M9 18l6-6-6-6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  "chevron-up": `<path d="M18 15l-6-6-6 6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  "chevron-down": `<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  "map-pin": `<path d="M12 21s-8-7.5-8-12a8 8 0 1 1 16 0c0 4.5-8 12-8 12z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><circle cx="12" cy="9" r="2.5" fill="none" stroke="currentColor" stroke-width="1.75"/>`,
  "origin-dot": `<circle cx="12" cy="12" r="4" fill="currentColor"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.75"/>`,
  walk: `<circle cx="12" cy="5" r="1.5" fill="currentColor"/><path d="M9 19l1-5 2.5 2.5L15 13l1 6M9.5 12l-1.5-4 3-1.5 3 5-2 2" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  car: `<path d="M5 11l2-5h10l2 5M3 11v6h2v2h2v-2h10v2h2v-2h2v-6H3z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="14" r="1.5" fill="currentColor"/><circle cx="16" cy="14" r="1.5" fill="currentColor"/>`,
  bus: `<rect x="3" y="4" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M3 9h18M8 18v2M16 18v2" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><circle cx="8" cy="14" r="1.5" fill="currentColor"/><circle cx="16" cy="14" r="1.5" fill="currentColor"/>`,
  train: `<rect x="5" y="2" width="14" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M5 10h14M8 18l-2 4M16 18l2 4M10 18h4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><circle cx="9" cy="14" r="1.5" fill="currentColor"/><circle cx="15" cy="14" r="1.5" fill="currentColor"/>`,
  clock: `<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M12 7v5l3 3" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  "shield-check": `<path d="M12 2l8 3v7c0 5-8 10-8 10S4 17 4 12V5l8-3z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  "shield-alert": `<path d="M12 2l8 3v7c0 5-8 10-8 10S4 17 4 12V5l8-3z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M12 9v4M12 17h.01" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  "check-circle": `<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M8.5 12l2.5 2.5 4.5-5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  "alert-triangle": `<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M12 9v4M12 17h.01" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  "x-circle": `<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M15 9l-6 6M9 9l6 6" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  road: `<path d="M3 3l6 18M21 3l-6 18M9 7h6M8 12h8M7 17h10" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  highway: `<path d="M3 3l4 18M21 3l-4 18M5 12h14" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M12 7v10" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-dasharray="2 2"/>`,
  "petrol-pump": `<path d="M3 22V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16H3z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M7 10h4M7 14h4M17 6h1a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-1" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  lamp: `<path d="M8 18h8M9 22h6M12 2v2M8 4l1.5 1.5M16 4l-1.5 1.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M7 14a5 5 0 1 1 10 0l-1 4H8l-1-4z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>`,
  "lamp-off": `<path d="M2 2l20 20M8 18h8M9 22h6M7 14a5 5 0 0 1 .89-2.89" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M10.5 6.5A5 5 0 0 1 17 11l-1 7H9l-.5-2" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>`,
  barrier: `<path d="M4 4l4 16M20 4l-4 16M4 4h16M4 12h16M4 20h16" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  moon: `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>`,
  rain: `<path d="M20 17.58A5 5 0 0 0 18 8h-1.26A8 8 0 1 0 4 15.25M8 19v3M12 17v5M16 19v3" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  thermometer: `<path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>`,
  sos: `<path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0z" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M12 8v4M12 16h.01" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  share: `<circle cx="18" cy="5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.75"/><circle cx="6" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="1.75"/><circle cx="18" cy="19" r="2.5" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  info: `<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M12 8h.01M12 12v6" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  settings: `<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  language: `<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M12 3c-4 4-4 14 0 18M3 12h18M4 7h16M4 17h16" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  "route-fork": `<path d="M6 3v6l6 3M6 9C6 9 6 18 6 21M18 3v6l-6 3M18 21l-6-9" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  flag: `<path d="M4 21V4l14 5-14 5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  home: `<path d="M3 12L12 3l9 9M5 10v10h5v-5h4v5h5V10" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  work: `<rect x="2" y="7" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2M12 12v4M10 14h4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  wait: `<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M12 7v5l3 3" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  cab: `<path d="M5 17H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2M14 9l-2-5H6L4 9M7 17h6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7.5" cy="17.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.75"/><circle cx="14.5" cy="17.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.75"/>`,
  done: `<path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  landmark: `<path d="M3 22h18M3 7h18M6 7V22M18 7V22M12 2l9 5H3z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
  atm: `<rect x="2" y="5" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M7 10h2M11 10h2M15 10h2M7 14h10" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>`,
  metro: `<rect x="3" y="2" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M3 10h18M7 22l-2-4h14l-2 4M10 6l2 4 2-4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="14" r="1.5" fill="currentColor"/><circle cx="16" cy="14" r="1.5" fill="currentColor"/>`,
  "gap-warning": `<path d="M12 2l10 18H2z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M12 9v5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-dasharray="2 2"/>`,
  "unknown-light": `<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-dasharray="2 3"/><circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-dasharray="3 2"/>`,
};

/** Map icon name to a step icon string from the backend. */
export const STEP_TO_ICON: Record<string, IconName> = {
  walk: "walk",
  wait: "wait",
  bus:  "bus",
  metro: "metro",
  cab: "cab",
  done: "done",
};

/** Map place type to an icon name. */
export const PLACE_TYPE_TO_ICON: Record<string, IconName> = {
  pharmacy: "medicine",
  hospital: "hospital",
  clinic: "hospital",
  police: "police",
  food: "food",
  restaurant: "food",
  cafe: "food",
  shop: "landmark",
  fuel: "petrol-pump",
  atm: "atm",
  help: "sos",
  metro: "metro",
};

interface IconProps {
  name: IconName;
  size?: number;
  /** Accessible label; if provided, role="img" is added and aria-hidden removed */
  label?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function Icon({ name, size = 24, label, className = "", style }: IconProps) {
  const paths = PATHS[name] ?? PATHS["info"];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: paths }}
    />
  );
}

/** Chevron helper kept for backward compat */
export function Chevron({ dir = "right" }: { dir?: "right" | "left" | "down" | "up" }) {
  const map: Record<string, IconName> = {
    right: "chevron-right",
    left: "chevron-left",
    down: "chevron-down",
    up: "chevron-up",
  };
  return <Icon name={map[dir] as IconName} size={22} />;
}

// Icons + words + colour together (UI_SPEC §1.6). SVGs render on all devices.

/** Tiny inline SVG for step icons in route cards. */
export const STEP_ICON: Record<string, string> = {
  walk: "Walking",
  wait: "Wait",
  bus: "Bus",
  metro: "Metro",
  done: "Done",
};

/** Category icons rendered as short text labels inside place chips. */
export const PLACE_ICON: Record<string, string> = {
  pharmacy: "Rx",
  hospital: "+",
  police: "PD",
  food: "FD",
  shop: "Sh",
  fuel: "GL",
  atm: "ATM",
  help: "SOS",
};

export const SAFETY = {
  safe: { icon: "●", color: "text-good" },
  ok: { icon: "●", color: "text-warn" },
  careful: { icon: "●", color: "text-bad" },
} as const;

export const TIMING = {
  on_time: { icon: "✓", color: "text-good" },
  maybe_late: { icon: "!", color: "text-warn" },
  too_late: { icon: "✕", color: "text-bad" },
} as const;

export const STATE = {
  open: { icon: "●", color: "text-good" },
  maybe_open: { icon: "●", color: "text-warn" },
  not_sure: { icon: "○", color: "text-soft" },
} as const;

export function Chevron({ dir = "right" }: { dir?: "right" | "left" | "down" | "up" }) {
  const r = { right: 0, down: 90, left: 180, up: 270 }[dir];
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" style={{ transform: `rotate(${r}deg)` }}>
      <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Map pin SVG used in place of the 📍 emoji. */
export function PinIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5 14.5 7.62 14.5 9 13.38 11.5 12 11.5z"/>
    </svg>
  );
}

/** House SVG used in place of ⌂ / 🏠 emoji. */
export function HomeIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"/>
      <path d="M9 21V12h6v9"/>
    </svg>
  );
}

/** Briefcase SVG used in place of 💼 emoji. */
export function WorkIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2"/>
      <path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/>
    </svg>
  );
}

/** Phone SVG for call actions. */
export function PhoneIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/>
    </svg>
  );
}

/** Map/layers icon SVG. */
export function MapIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/>
      <line x1="8" y1="2" x2="8" y2="18"/>
      <line x1="16" y1="6" x2="16" y2="22"/>
    </svg>
  );
}

/** Chat/message icon SVG. */
export function ChatIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
    </svg>
  );
}

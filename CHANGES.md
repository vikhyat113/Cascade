# Changes after the build (add-on mode)

Each request: what it was, which layer it touched, what was done.

## 1. Street map from the web version back (stable-1)
- **Request**: "the map view we had initially in web has gone, fix that too".
- **Layer**: map component (`components/MapCanvas.tsx`), theme CSS (`index.css`), config (`config.ts` → `map`), Capacitor config (User-Agent).
- **Rule check**: the spec says "no downloaded tiles" so the map works offline. Kept that promise with the simplest version: street tiles (OpenStreetMap, night palette, same look as the web version) **only while they load**; offline or on tile errors the app hides them and draws its bundled road network, as before. Never both at once.
- **Also fixed**: on the Trip screen the map was zoomed far out (it fitted the way to the Result screen's taller sheet and ignored the next-step card); it now re-fits when the sheet settles and leaves room for the card.
- **Checked**: tests pass; browser run at 360 px online (street map, way framed) and offline (road map only, "Offline: using saved info").

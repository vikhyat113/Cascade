/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SHOW_DEMO?: string;
  readonly VITE_DISPATCH_URL?: string;
  readonly VITE_HERE_API_KEY?: string;
  readonly VITE_MAP_PROVIDER?: "here" | "osm";
}

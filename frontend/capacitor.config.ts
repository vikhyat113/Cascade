import type { CapacitorConfig } from "@capacitor/cli";

// NightWay Android app. The engine runs inside the app on bundled data (no server needed).
const config: CapacitorConfig = {
  appId: "org.cascade.nightway",
  appName: "NightWay",
  webDir: "dist",
  android: { backgroundColor: "#0a0f1e" },
  plugins: {
    // lets the WebView reach the plain-http demo dispatch server (http://localhost:8787 over `adb reverse`)
    CapacitorHttp: { enabled: true },
  },
};

export default config;

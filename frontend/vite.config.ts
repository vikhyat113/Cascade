import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: { output: { manualChunks: { leaflet: ["leaflet"] } } },
  },
  server: {
    port: 5173,
    host: true,
    proxy: { "/api": { target: "http://localhost:8000", changeOrigin: true } },
  },
});

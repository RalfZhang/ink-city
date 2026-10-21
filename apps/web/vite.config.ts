import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // The shared components (`@inkcity/ui`) must use the app's copies of these: a
    // second react-i18next would read an i18next nobody initialized, a second React
    // breaks hooks. The workspace catalog keeps one version of each, and this keeps
    // one copy even if a version drifts anyway.
    dedupe: ["react", "react-dom", "i18next", "react-i18next"],
  },
  // An ES-module worker, so the map worker can load `@inkcity/osm` lazily — only
  // the last rung of its fetch ladder needs it (src/map/load.ts).
  worker: { format: "es" },
  build: { target: "es2022" },
  server: { port: 5174, strictPort: true },
});

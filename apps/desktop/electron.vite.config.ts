import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { CSP_META } from "./src/main/csp";

/** The built page loads from file://, which has no response headers, so its CSP goes in a <meta> tag. */
const cspMeta = (): Plugin => ({
  name: "landlens-csp-meta",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP_META}" />`),
});

// Main and preload are bundled whole (workspace packages are TypeScript source); only electron and Node built-ins
// stay external. The renderer is a plain web bundle with no Node access.
export default defineConfig({
  main: {
    build: { externalizeDeps: false, rollupOptions: { input: { index: resolve(__dirname, "src/main/index.ts") } } },
  },
  preload: {
    build: { externalizeDeps: false, rollupOptions: { input: { index: resolve(__dirname, "src/preload/index.ts") } } },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: { rollupOptions: { input: { index: resolve(__dirname, "src/renderer/index.html") } } },
    plugins: [react(), cspMeta()],
  },
});

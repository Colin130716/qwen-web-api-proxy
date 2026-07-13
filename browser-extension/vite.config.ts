import { defineConfig } from "vite";
import { resolve } from "path";

// This config is used by `vite build --watch` (dev mode).
// For production builds, see vite.content.config.ts and vite.main.config.ts.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        content_script: resolve(__dirname, "src/content_script.ts"),
        service_worker: resolve(__dirname, "src/service_worker.ts"),
        "popup/popup": resolve(__dirname, "src/popup/popup.ts"),
      },
      output: {
        entryFileNames: "src/[name].js",
        format: "iife",
      },
    },
  },
});

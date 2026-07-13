import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { resolve } from "path";

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        { src: "manifest.json", dest: "." },
        { src: "src/popup/popup.html", dest: "src/popup" },
        { src: "icon-48.png", dest: "." },
        { src: "icon-128.png", dest: "." },
        { src: "src/popup/popup.css", dest: "src/popup" },
        { src: "src/page_script.js", dest: "src" },
      ],
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        content_script: resolve(__dirname, "src/content_script.ts"),
      },
      output: {
        entryFileNames: "src/[name].js",
        format: "iife",
      },
    },
  },
});

// Browser-demo build: the real frontend with every Tauri module swapped for a
// shim + mock backend. Output is the static site at website/demo/.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const shim = (name: string) =>
  fileURLToPath(new URL(`./demo/shims/${name}.ts`, import.meta.url));

export default defineConfig({
  root: "demo",
  base: "./",
  plugins: [react()],
  clearScreen: false,
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  resolve: {
    alias: [
      { find: "@tauri-apps/api/core", replacement: shim("tauri-core") },
      { find: "@tauri-apps/api/dpi", replacement: shim("tauri-dpi") },
      { find: "@tauri-apps/api/window", replacement: shim("tauri-window") },
      { find: "@tauri-apps/api/event", replacement: shim("tauri-event") },
      { find: "@tauri-apps/plugin-updater", replacement: shim("plugin-updater") },
      { find: "@tauri-apps/plugin-process", replacement: shim("plugin-process") },
      { find: "@tauri-apps/plugin-autostart", replacement: shim("plugin-autostart") },
      { find: "@crabnebula/tauri-plugin-drag", replacement: shim("plugin-drag") },
    ],
  },
  server: {
    port: 5188,
    strictPort: true,
  },
  build: {
    target: "esnext",
    outDir: fileURLToPath(new URL("./website/demo", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./demo/index.html", import.meta.url)),
        quick: fileURLToPath(new URL("./demo/quick.html", import.meta.url)),
        control: fileURLToPath(new URL("./demo/control.html", import.meta.url)),
      },
    },
  },
});

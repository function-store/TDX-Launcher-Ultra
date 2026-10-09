import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    // Off vite's 5173 default so TDXLU never collides with other vite projects.
    port: 5183,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      input: {
        // Main app webview + the standalone browser control panel
        // (served by the Rust control server, see control_server.rs) + the
        // quick-launch overlay window (see lib.rs setup).
        main: "index.html",
        control: "control.html",
        quick: "quick.html",
        // The page TouchDesigner's Palette Browser shows in its TDXLU /
        // Patreon tabs (served by the control server, see palette_tabs.rs).
        palette: "palette.html",
      },
    },
  },
});

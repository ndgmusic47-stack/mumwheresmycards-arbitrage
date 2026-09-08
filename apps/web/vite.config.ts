import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Base path matches the private application route: mumwheresmycards.com/trade
export default defineConfig({
  base: "/trade/",
  plugins: [react()],
  server: {
    proxy: {
      "/trade/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    // Cloudflare Workers Static Assets resolves a request's FULL incoming
    // path (including the route's /trade prefix) against the configured
    // [assets] directory — it does NOT strip the prefix first. `base`
    // above only rewrites the *references* inside index.html/JS to
    // "/trade/...", it does not relocate where Vite writes the files. So
    // the physical build output must live under a matching "trade/"
    // subfolder, or every asset request 404s internally and silently falls
    // back to serving index.html (200 OK, wrong content, "Expected a
    // JavaScript module but server responded with text/html" in console).
    // wrangler.toml's [assets] directory stays "../web/dist" (the parent
    // of this folder) — unchanged.
    outDir: "dist/trade",
    sourcemap: true,
  },
});

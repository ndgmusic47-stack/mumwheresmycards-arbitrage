import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Base path matches the private application route: mumwheresmycards.com/arbitrage
export default defineConfig({
  base: "/arbitrage/",
  plugins: [react()],
  server: {
    proxy: {
      "/arbitrage/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});

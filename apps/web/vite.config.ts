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
    outDir: "dist",
    sourcemap: true,
  },
});

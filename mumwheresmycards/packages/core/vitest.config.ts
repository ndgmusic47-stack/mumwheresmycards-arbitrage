import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "core",
    root: __dirname,
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});

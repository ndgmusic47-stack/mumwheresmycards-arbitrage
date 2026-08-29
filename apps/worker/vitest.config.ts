import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "worker",
    root: __dirname,
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});

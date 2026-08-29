import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "providers",
    root: __dirname,
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});

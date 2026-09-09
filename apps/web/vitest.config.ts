import { defineConfig } from "vitest/config";

/**
 * Added 2026-09-08. `apps/web` had no test project at all, which was fine
 * while everything in it was React rendering — but `src/state/filters.ts`
 * is pure business logic that decides which filters reach the server, and
 * getting that wrong silently deletes whole strategies' worth of rows from
 * the user's view (see gradeServerFilters.test.ts's own doc comment, and
 * the project doc's "verify at every layer" lesson).
 *
 * Deliberately `environment: "node"` and scoped to `test/**` — this is for
 * the pure modules only. Component tests would need jsdom and a much
 * larger setup; nothing here pretends to offer that yet.
 */
export default defineConfig({
  test: {
    name: "web",
    root: __dirname,
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Real-DB tests share a Postgres instance; run serially to keep them
    // deterministic and to avoid cross-test interference on shared tables.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});

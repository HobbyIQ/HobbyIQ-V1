import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: [
      "tests/**/*.test.ts",
      "harness/**/*.test.ts",
      "backend/tests/**/*.test.ts",
      "backend/harness/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/deploy-verify/**",
      "**/hobbyiq-backend-zip-contents/**",
      "**/backend/tests/pricing/**",
      "**/*.test.js",
    ],
    env: {
      NODE_ENV: "test",
    },
    // PHASE-4A-2.2 (2026-06-02): bumped from default 10s. Integration-style
    // tests that `await import("../src/app")` in beforeAll trigger a cold
    // module-graph transform whose cost grew past 10s after compiq surface
    // additions (cache hardening + ebay poll + corpus + resolver work).
    // Module evaluation itself is fast; the cost is one-time SWC transform.
    hookTimeout: 30000,
  },
});

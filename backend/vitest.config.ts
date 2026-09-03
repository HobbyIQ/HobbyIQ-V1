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
      // CF-CI-AUTH-GUARDS-P0.9 (Drew, 2026-07-26). PR #781 added
      // fail-closed guards to authService.ts + ebayAuth.service.ts that
      // throw at module-load if AUTH_SESSION_SECRET is unset, retired-
      // default, or <32 chars. Every test file that transitively imports
      // authService therefore fails to load in CI (npm test runs with
      // NODE_ENV=test but no ambient secret). Provide a synthetic,
      // clearly-non-prod value here so the guard is satisfied without
      // relaxing prod behaviour.
      AUTH_SESSION_SECRET: "vitest-only-not-a-production-secret-min-length-32",
    },
    // PHASE-4A-2.2 (2026-06-02): bumped from default 10s. Integration-style
    // tests that `await import("../src/app")` in beforeAll trigger a cold
    // module-graph transform whose cost grew past 10s after compiq surface
    // additions (cache hardening + ebay poll + corpus + resolver work).
    // Module evaluation itself is fast; the cost is one-time SWC transform.
    //
    // CF-HOOK-TIMEOUT-ONEDRIVE (2026-08-31): bumped 30s → 120s. Same cause,
    // larger constant. On the OneDrive-backed checkout the cold transform of
    // the compiq module graph does not finish inside 30s, so three route
    // suites — compiqRoutePredictionShape, compiqRouteContractCleanup,
    // compiqRouteGradedEstimatesSurface — fail their beforeAll and SKIP every
    // assertion (a skipped suite is a silent gap, not a red test). Verified:
    // all three fail in isolation at 30s and pass at a raised timeout with no
    // other change. This is I/O latency on the module load, not a hang — the
    // ceiling only has to clear the one-time cost.
    // CF-CHRONIC-REDS-DIST (2026-09-03). Ten suites load a shipped ops
    // script out of backend/scripts/*.cjs, and those scripts `require()`
    // backend/dist/... because that is what runs in production. On a clone
    // that has not built, every one of them dies at import and reports
    // "0 test" -- a silent gap rather than a red assertion. This builds dist/
    // once, and only when it is missing or stale. See the file for the
    // per-test reasoning on which suites keep dist and which moved to src.
    globalSetup: ["tests/setup/ensureDistBuilt.ts"],
    hookTimeout: 120000,
    // CF-TEST-TIMEOUT-BUMP (Drew, 2026-07-21). Bumped from 5s default
    // to 30s. Full-suite runs put heavy fork/import pressure on nodes
    // that hit dynamic import chains (async import("../src/...") in
    // beforeEach). Tests that are fast in isolation time out under
    // that load. 30s matches hookTimeout and leaves plenty of headroom.
    testTimeout: 30000,
  },
});

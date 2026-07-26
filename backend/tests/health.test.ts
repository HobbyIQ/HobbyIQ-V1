import request from "supertest";
import { afterEach, vi } from "vitest";
import app from "../src/app";

describe("/api/health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 200 and status ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("HobbyIQ API");
  });

  it("includes a build object with sha, shaShort, branch, deployedAt fields", async () => {
    const res = await request(app).get("/api/health");
    expect(res.body.build).toBeDefined();
    expect(res.body.build).toEqual(
      expect.objectContaining({
        sha: expect.any(String),
        shaShort: expect.any(String),
        branch: expect.any(String),
        deployedAt: expect.any(String),
      })
    );
  });

  it("falls back to \"unknown\" when build env vars are unset", async () => {
    vi.stubEnv("GIT_SHA", "");
    vi.stubEnv("GIT_SHA_SHORT", "");
    vi.stubEnv("GIT_BRANCH", "");
    vi.stubEnv("DEPLOYED_AT", "");

    const res = await request(app).get("/api/health");
    // Env-var-derived fields fall back to "unknown". shaFromCode et al.
    // are code-baked and independent of env — they may be null in test
    // env (no dist/build-info.json) or a real SHA in dev. Asserted by
    // separate test below.
    expect(res.body.build).toEqual(
      expect.objectContaining({
        sha: "unknown",
        shaShort: "unknown",
        branch: "unknown",
        deployedAt: "unknown",
      })
    );
  });

  it("reflects build env vars when they are set", async () => {
    vi.stubEnv("GIT_SHA", "abc123def4567890abc123def4567890abc12345");
    vi.stubEnv("GIT_SHA_SHORT", "abc123d");
    vi.stubEnv("GIT_BRANCH", "feat/health-endpoint-build-info");
    vi.stubEnv("DEPLOYED_AT", "2026-05-19T22:30:00Z");

    const res = await request(app).get("/api/health");
    expect(res.body.build).toEqual(
      expect.objectContaining({
        sha: "abc123def4567890abc123def4567890abc12345",
        shaShort: "abc123d",
        branch: "feat/health-endpoint-build-info",
        deployedAt: "2026-05-19T22:30:00Z",
      })
    );
  });

  // CF-DEPLOY-SCRIPT-RESTART-FIX — code-baked SHA field tests.
  // shaFromCode reads dist/build-info.json relative to the COMPILED
  // module path. Under vitest the module loads from src/routes/, so
  // the build-info.json lookup resolves to src/build-info.json which
  // doesn't exist — shaFromCode falls back to null. This is the
  // INTENDED test-environment behavior (tests don't need a baked SHA).
  describe("CF-DEPLOY-SCRIPT-RESTART-FIX — shaFromCode field", () => {
    it("response keys include shaFromCode / shaFromCodeShort / branchFromCode / builtAt (presence check; values may be null in test env)", async () => {
      const res = await request(app).get("/api/health");
      const keys = Object.keys(res.body.build);
      expect(keys).toContain("shaFromCode");
      expect(keys).toContain("shaFromCodeShort");
      expect(keys).toContain("branchFromCode");
      expect(keys).toContain("builtAt");
    });

    it("missing dist/build-info.json gracefully degrades to null (no crash)", async () => {
      // Under vitest the module loads from src/routes/, no
      // build-info.json sibling exists, so shaFromCode et al. should be
      // null. Asserts the fallback path is the one being exercised.
      const res = await request(app).get("/api/health");
      expect(res.body.build.shaFromCode).toBeNull();
      expect(res.body.build.shaFromCodeShort).toBeNull();
      expect(res.body.build.branchFromCode).toBeNull();
      expect(res.body.build.builtAt).toBeNull();
    });

    it("shaFromCode is independent of GIT_SHA env var manipulation", async () => {
      // Stubbing GIT_SHA should NOT affect shaFromCode (the whole point
      // of the code-baked field is to be env-var-independent).
      vi.stubEnv("GIT_SHA", "different-sha-from-env");
      const res = await request(app).get("/api/health");
      expect(res.body.build.sha).toBe("different-sha-from-env");
      expect(res.body.build.shaFromCode).toBeNull(); // still null, not the env value
    });
  });
});

// CF-HEALTH-DEEP-P1 (Drew, 2026-07-26). Deep readiness probe. Cosmos
// probe is exercised against the real getPortfolioContainer(); under
// vitest that returns null (isPortfolioTestMode) and the probe reports
// "down" — the test asserts the shape + status-code contract rather
// than end-to-end Cosmos success.
describe("/api/health/deep", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a well-shaped body with checks.cosmos + checks.config", async () => {
    const res = await request(app).get("/api/health/deep");
    expect([200, 503]).toContain(res.status);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: expect.any(Boolean),
        status: expect.stringMatching(/^(healthy|degraded|down)$/),
        uptimeSec: expect.any(Number),
        totalLatencyMs: expect.any(Number),
        timestamp: expect.any(String),
        checks: expect.objectContaining({
          cosmos: expect.objectContaining({
            status: expect.stringMatching(/^(ok|degraded|down)$/),
            latencyMs: expect.any(Number),
          }),
          config: expect.objectContaining({
            status: expect.stringMatching(/^(ok|down)$/),
            criticalEnvsMissing: expect.any(Array),
            recommendedEnvsMissing: expect.any(Array),
          }),
        }),
      }),
    );
  });

  it("returns 503 when a critical env is missing", async () => {
    // In test mode Cosmos is unreachable anyway (isPortfolioTestMode),
    // so the total status will be down regardless of env. This asserts
    // the config-check surfaces the missing env in the output.
    vi.stubEnv("AUTH_SESSION_SECRET", "");
    vi.stubEnv("COSMOS_CONNECTION_STRING", "");
    vi.stubEnv("COSMOS_ENDPOINT", "");
    vi.stubEnv("CARD_HEDGE_API_KEY", "");
    const res = await request(app).get("/api/health/deep");
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.checks.config.status).toBe("down");
    expect(res.body.checks.config.criticalEnvsMissing).toContain("AUTH_SESSION_SECRET");
    expect(res.body.checks.config.criticalEnvsMissing).toContain("CARD_HEDGE_API_KEY");
  });

  it("recommendedEnvsMissing enumerates App Insights / Cardsight when absent (non-fatal)", async () => {
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "");
    vi.stubEnv("CARDSIGHT_API_KEY", "");
    const res = await request(app).get("/api/health/deep");
    expect(res.body.checks.config.recommendedEnvsMissing).toEqual(
      expect.arrayContaining(["APPLICATIONINSIGHTS_CONNECTION_STRING", "CARDSIGHT_API_KEY"]),
    );
  });
});


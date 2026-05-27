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


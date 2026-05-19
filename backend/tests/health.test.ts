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
    expect(res.body.build).toEqual({
      sha: "unknown",
      shaShort: "unknown",
      branch: "unknown",
      deployedAt: "unknown",
    });
  });

  it("reflects build env vars when they are set", async () => {
    vi.stubEnv("GIT_SHA", "abc123def4567890abc123def4567890abc12345");
    vi.stubEnv("GIT_SHA_SHORT", "abc123d");
    vi.stubEnv("GIT_BRANCH", "feat/health-endpoint-build-info");
    vi.stubEnv("DEPLOYED_AT", "2026-05-19T22:30:00Z");

    const res = await request(app).get("/api/health");
    expect(res.body.build).toEqual({
      sha: "abc123def4567890abc123def4567890abc12345",
      shaShort: "abc123d",
      branch: "feat/health-endpoint-build-info",
      deployedAt: "2026-05-19T22:30:00Z",
    });
  });
});


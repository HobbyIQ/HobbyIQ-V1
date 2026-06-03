// CF-SCANNING-B5-FIXES (2026-06-03): admin warm endpoint tests.
//
//   POST /api/internal/cardsight-inventory/refresh

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";

// Mock the job so we don't actually paginate Cardsight in unit tests.
const runInventoryRefreshJob = vi.hoisted(() => vi.fn());

vi.mock("../src/jobs/cardsightInventoryRefresh.job.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    runInventoryRefreshJob,
  };
});

let app: any;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) {
    app = (await import("../src/app")).default;
  }
});

describe("POST /api/internal/cardsight-inventory/refresh", () => {
  it("503 when CARDSIGHT_INVENTORY_ADMIN_TOKEN is not configured", async () => {
    delete process.env.CARDSIGHT_INVENTORY_ADMIN_TOKEN;
    const r = await request(app)
      .post("/api/internal/cardsight-inventory/refresh")
      .set("x-admin-token", "anything");
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/not configured/i);
    expect(runInventoryRefreshJob).not.toHaveBeenCalled();
  });

  it("401 with wrong admin token", async () => {
    process.env.CARDSIGHT_INVENTORY_ADMIN_TOKEN = "correct-token";
    const r = await request(app)
      .post("/api/internal/cardsight-inventory/refresh")
      .set("x-admin-token", "wrong-token");
    expect(r.status).toBe(401);
    expect(runInventoryRefreshJob).not.toHaveBeenCalled();
  });

  it("401 with no admin token header", async () => {
    process.env.CARDSIGHT_INVENTORY_ADMIN_TOKEN = "correct-token";
    const r = await request(app).post("/api/internal/cardsight-inventory/refresh");
    expect(r.status).toBe(401);
    expect(runInventoryRefreshJob).not.toHaveBeenCalled();
  });

  it("200 with valid token — returns refresh stats", async () => {
    process.env.CARDSIGHT_INVENTORY_ADMIN_TOKEN = "correct-token";
    runInventoryRefreshJob.mockResolvedValueOnce({
      totalCount: 2998,
      segmentCounts: { Baseball: 1322, Football: 538, Hockey: 353 },
      pagesFetched: 60,
      durationMs: 92413,
      refreshedAt: "2026-06-03T22:30:00.000Z",
    });
    const r = await request(app)
      .post("/api/internal/cardsight-inventory/refresh")
      .set("x-admin-token", "correct-token");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      success: true,
      refreshedAt: "2026-06-03T22:30:00.000Z",
      totalCount: 2998,
      segmentCounts: { Baseball: 1322, Football: 538, Hockey: 353 },
      pagesFetched: 60,
      durationMs: 92413,
    });
    expect(runInventoryRefreshJob).toHaveBeenCalledTimes(1);
  });

  it("500 when the refresh job throws", async () => {
    process.env.CARDSIGHT_INVENTORY_ADMIN_TOKEN = "correct-token";
    runInventoryRefreshJob.mockRejectedValueOnce(new Error("Cardsight 503"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await request(app)
      .post("/api/internal/cardsight-inventory/refresh")
      .set("x-admin-token", "correct-token");
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/Cardsight 503/);
    errSpy.mockRestore();
  });
});

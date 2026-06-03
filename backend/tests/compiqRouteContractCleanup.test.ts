import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.COMPIQ_CORPUS_DISABLED = "1";

vi.mock("../src/services/compiq/compiqEstimate.service.js", async () => {
  const actual = await vi.importActual<any>("../src/services/compiq/compiqEstimate.service.js");
  return {
    ...actual,
    computeEstimate: vi.fn(async () => ({
      fairMarketValue: 120,
      premiumValue: 138,
      quickSaleValue: 106,
      marketDNA: { trend: "flat", speed: "Normal" },
      confidence: { pricingConfidence: 70 },
      source: "live",
      verdict: "ok",
      compsUsed: 4,
      compsAvailable: 6,
      recentComps: [],
      cardIdentity: null,
      gradeUsed: "Raw",
      daysSinceNewestComp: 2,
      variantWarning: [],
      neighborSynthesis: null,
      crossParallelAnchor: null,
      effectiveFmv: 120,
    })),
  };
});

// CF-PAYMENTS-B1-TWEAK: /api/compiq/search now session-gated.
vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => ({
      userId: "test-user",
      email: "t@t",
      username: null,
      fullName: null,
      plan: "pro_seller",
      createdAt: "2026-01-01T00:00:00Z",
    })),
  };
});

let app: any;

beforeAll(async () => {
  app = (await import("../src/app")).default;
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

describe("/api/compiq/search contract cleanup", () => {
  it("emits predictedPriceRange and omits neighborSynthesisDebug", async () => {
    const res = await request(app)
      .post("/api/compiq/search")
      .set("x-session-id", "test-sess")
      .send({ query: "2024 Bowman Chrome Paul Skenes" });

    expect(res.status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(res.body, "predictedPrice")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(res.body, "predictedPriceRange")).toBe(true);
    expect(res.body.predictedPriceRange).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(res.body, "neighborSynthesisDebug")).toBe(false);
  });
});

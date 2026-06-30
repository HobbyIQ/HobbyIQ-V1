// CF-CH-RESPONSE-SURFACE-SUBBLOCKS (2026-06-27) — wire-shape parity
// tests for the three trend-aware sub-block keys.
//
// PRIOR-CF GAP: CF-CH-MODEL-EXPECTATION-TREND-ANCHOR added the helper
// emitting modelExpectation/modelSignal + chCompCount; CF-CH-PERSISTENCE-PATCH
// fixed the Cosmos write boundary; but the ROUTE-HANDLER hand-picked
// response assemblers in compiq.routes.ts (6 sites) never added the
// three keys to the picker list. Live curl confirmation: POST
// /api/compiq/price-by-id returned a full estimate payload with no
// modelExpectation/modelSignal/chCompCount keys at all.
//
// THIS FILE PINS THE WIRE CONTRACT — every priced response shape must
// emit all three keys:
//   1. Populated values flow through verbatim (CardHedge-served path).
//   2. Absent fields surface as `null` (non-CH or thin/null branch).
//   3. Keys are ALWAYS PRESENT regardless of branch — iOS decoder has a
//      stable contract; future hand-picker omission gets caught.

import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.COMPIQ_CORPUS_DISABLED = "1";

const SUB_BLOCK_KEYS = ["modelExpectation", "modelSignal", "chCompCount"] as const;

const POPULATED_MODEL_EXPECTATION = {
  value: 314.74,
  range: [234.31, 401.62],
  multiplier: 2.974,
  multiplierRange: [2.214, 3.795],
  basis: "base_anchored_off_sample_paired_premium",
  n: 9,
  baseAutoMedian: 84,
  baseAutoCount: 78,
  trendAnchor: {
    direction: "up",
    slopePctPerDay: 1.85,
    trendConfidence: 0.42,
    windowDays: 21,
    daysWithSales: 17,
    projectedBaseAtSale: 105.81,
    projectedBaseToday: 108.92,
    allTimeBaseMedian: 84,
  },
  forwardProjection: {
    low: 280.41,
    high: 360.83,
    basis: "trend-projection-prediction-interval",
    confidence: 0.42,
  },
  positionSignal: {
    purchasePrice: 200,
    gainVsLastSale: 250,
    gainVsExpectation: 114.74,
    gainPct: 125,
  },
};

const POPULATED_MODEL_SIGNAL = {
  lean: "sell",
  deltaPct: 43,
  expectation: 314.74,
  effectiveMultiplier: 5.357,
};

const POPULATED_CH_COMP_COUNT = 1;

// CF-PAYMENTS-B1: /price + /price-by-id are session-gated.
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

// CardHedge-served est WITH populated sub-blocks.
vi.mock("../src/services/compiq/compiqEstimate.service.js", async () => {
  const actual = await vi.importActual<any>("../src/services/compiq/compiqEstimate.service.js");
  return {
    ...actual,
    computeEstimate: vi.fn(async () => ({
      fairMarketValue: 314,
      premiumValue: 360,
      quickSaleValue: 280,
      marketDNA: { trend: "up", speed: "Normal" },
      confidence: { pricingConfidence: 75 },
      source: "live",
      verdict: "Sell",
      compsUsed: 1,
      compsAvailable: 1,
      recentComps: [],
      cardIdentity: { cardId: "fixture-card-id" },
      gradeUsed: "Raw",
      daysSinceNewestComp: 0,
      variantWarning: [],
      neighborSynthesis: null,
      crossParallelAnchor: null,
      effectiveFmv: 314,
      lastSale: { price: 450, soldDate: "2026-06-19T00:01:00.000Z" },
      estimateSource: "cardhedge-last-sale",
      estimatedValue: 314.74,
      estimateRange: [234.31, 401.62],
      estimateBasis: "base_anchored_off_sample_paired_premium",
      modelExpectation: POPULATED_MODEL_EXPECTATION,
      modelSignal: POPULATED_MODEL_SIGNAL,
      chCompCount: POPULATED_CH_COMP_COUNT,
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

function expectSubBlocksKeysPresent(body: any) {
  for (const k of SUB_BLOCK_KEYS) {
    expect(
      Object.prototype.hasOwnProperty.call(body, k),
      `key ${k} must be PRESENT (even when null) on the response`,
    ).toBe(true);
  }
}

function expectSubBlocksPopulated(body: any) {
  expectSubBlocksKeysPresent(body);
  expect(body.modelExpectation).toEqual(POPULATED_MODEL_EXPECTATION);
  expect(body.modelSignal).toEqual(POPULATED_MODEL_SIGNAL);
  expect(body.chCompCount).toBe(POPULATED_CH_COMP_COUNT);
}

describe("CF-CH-RESPONSE-SURFACE-SUBBLOCKS — populated sub-blocks propagate through every priced route", () => {
  it("/api/compiq/search carries modelExpectation + modelSignal + chCompCount verbatim", async () => {
    const res = await request(app)
      .post("/api/compiq/search")
      .set("x-session-id", "test-sess")
      .send({ query: "2024 Bowman Chrome Brett Hartman BXF /150 auto" });
    expect(res.status).toBe(200);
    expectSubBlocksPopulated(res.body);
  });

  it("/api/compiq/price carries modelExpectation + modelSignal + chCompCount verbatim", async () => {
    const res = await request(app)
      .post("/api/compiq/price")
      .set("x-session-id", "test-sess")
      .send({ query: "2024 Bowman Chrome Brett Hartman BXF /150 auto" });
    expect(res.status).toBe(200);
    expectSubBlocksPopulated(res.body);
  });

  it("/api/compiq/price-by-id carries modelExpectation + modelSignal + chCompCount verbatim", async () => {
    const res = await request(app)
      .post("/api/compiq/price-by-id")
      .set("x-session-id", "test-sess")
      .send({ cardId: "fixture-card-id" });
    expect(res.status).toBe(200);
    expectSubBlocksPopulated(res.body);
  });
});

describe("CF-CH-RESPONSE-SURFACE-SUBBLOCKS — keys-always-present invariant for non-CH / thin branches", () => {
  beforeEach(async () => {
    const svc = await import("../src/services/compiq/compiqEstimate.service.js");
    (svc.computeEstimate as any).mockImplementation(async () => ({
      fairMarketValue: 150,
      premiumValue: 172,
      quickSaleValue: 132,
      marketDNA: { trend: "neutral", speed: "Normal" },
      confidence: { pricingConfidence: 60 },
      source: "live",
      verdict: "Hold",
      compsUsed: 35,
      compsAvailable: 35,
      recentComps: [],
      cardIdentity: { cardId: "fixture-observed-card" },
      gradeUsed: "Raw",
      daysSinceNewestComp: 1,
      variantWarning: [],
      neighborSynthesis: null,
      crossParallelAnchor: null,
      effectiveFmv: 150,
      lastSale: { price: 152, soldDate: "2026-06-26T00:00:00.000Z" },
      estimateSource: "observed",
      estimatedValue: 150,
      estimateRange: [140, 165],
      estimateBasis: "comps-direct",
      // NO modelExpectation / modelSignal / chCompCount on the est.
    }));
  });

  it("/api/compiq/search emits all 3 sub-block keys with value null when est doesn't carry them", async () => {
    const res = await request(app)
      .post("/api/compiq/search")
      .set("x-session-id", "test-sess")
      .send({ query: "2024 Topps Chrome Mike Trout" });
    expect(res.status).toBe(200);
    expectSubBlocksKeysPresent(res.body);
    expect(res.body.modelExpectation).toBeNull();
    expect(res.body.modelSignal).toBeNull();
    expect(res.body.chCompCount).toBeNull();
  });

  it("/api/compiq/price emits all 3 sub-block keys with value null when est doesn't carry them", async () => {
    const res = await request(app)
      .post("/api/compiq/price")
      .set("x-session-id", "test-sess")
      .send({ query: "2024 Topps Chrome Mike Trout" });
    expect(res.status).toBe(200);
    expectSubBlocksKeysPresent(res.body);
    expect(res.body.modelExpectation).toBeNull();
    expect(res.body.modelSignal).toBeNull();
    expect(res.body.chCompCount).toBeNull();
  });

  it("/api/compiq/price-by-id emits all 3 sub-block keys with value null when est doesn't carry them", async () => {
    const res = await request(app)
      .post("/api/compiq/price-by-id")
      .set("x-session-id", "test-sess")
      .send({ cardId: "fixture-observed-card" });
    expect(res.status).toBe(200);
    expectSubBlocksKeysPresent(res.body);
    expect(res.body.modelExpectation).toBeNull();
    expect(res.body.modelSignal).toBeNull();
    expect(res.body.chCompCount).toBeNull();
  });
});

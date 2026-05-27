// CF-PREDICTION-LAYER-CONSISTENCY-COMPLETION (Phase 3) — response shape
// parity tests. Asserts that /search, /price, /price-by-id, /bulk each
// propagate the new prediction-layer fields from computeEstimate's result.
//
// Prevents future drift: if a new prediction-shape field gets added on
// /estimate, these tests will fail until the field is plumbed through
// every user-facing endpoint.

import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.COMPIQ_CORPUS_DISABLED = "1";

// Mock computeEstimate to return a fully-populated estimate including
// the new prediction-layer fields. Each endpoint test asserts the response
// surfaces these without dropping or null-collapsing them.
vi.mock("../src/services/compiq/compiqEstimate.service.js", async () => {
  const actual = await vi.importActual<any>("../src/services/compiq/compiqEstimate.service.js");
  return {
    ...actual,
    computeEstimate: vi.fn(async () => ({
      fairMarketValue: 100,
      premiumValue: 115,
      quickSaleValue: 88,
      marketDNA: { trend: "up", speed: "Normal" },
      confidence: { pricingConfidence: 75 },
      source: "live",
      verdict: "Hold",
      compsUsed: 8,
      compsAvailable: 12,
      recentComps: [],
      cardIdentity: { cardId: "fixture-card-id" },
      gradeUsed: "Raw",
      daysSinceNewestComp: 5,
      variantWarning: [],
      neighborSynthesis: null,
      crossParallelAnchor: null,
      effectiveFmv: 100,

      // The new prediction-layer fields the response shape must propagate.
      predictedPrice: 106.5,
      predictedPriceRange: { low: 98, high: 115 },
      predictedPriceAttribution: {
        mechanism: "trendiq-projection",
        forwardProjectionFactor: 1.065,
        trendIQComposite: 1.108,
        trendIQDirection: "up",
        trendIQCoverage: "full",
      },
      trendIQ: {
        composite: 1.108,
        direction: "up",
        impliedPct: 10.8,
        lastUpdated: "2026-05-27T18:00:00.000Z",
        components: {
          playerMomentum: { multiplier: 1.2, flags: [], componentSignals: {}, lastUpdated: null, sourceUrl: null },
          cardTrajectory: null,
          segmentTrajectory: null,
        },
        weights: { playerMomentum: 1, cardTrajectory: 0, segmentTrajectory: 0 },
        coverage: "player_only",
      },
      signalsLastUpdated: "2026-05-27T18:00:00.000Z",
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

const PREDICTION_FIELDS = [
  "predictedPrice",
  "predictedPriceRange",
  "predictedPriceAttribution",
  "trendIQ",
  "signalsLastUpdated",
];

function expectPredictionFieldsPropagated(body: any) {
  for (const f of PREDICTION_FIELDS) {
    expect(Object.prototype.hasOwnProperty.call(body, f)).toBe(true);
  }
  expect(body.predictedPrice).toBe(106.5);
  expect(body.predictedPriceRange).toEqual({ low: 98, high: 115 });
  expect(body.predictedPriceAttribution).toMatchObject({
    mechanism: "trendiq-projection",
    forwardProjectionFactor: 1.065,
    trendIQComposite: 1.108,
  });
  expect(body.trendIQ).toMatchObject({
    composite: 1.108,
    direction: "up",
    coverage: "player_only",
  });
  expect(body.signalsLastUpdated).toBe("2026-05-27T18:00:00.000Z");
}

describe("CF-PREDICTION-LAYER-CONSISTENCY-COMPLETION — response shape parity", () => {
  it("/api/compiq/search propagates predictedPrice + trendIQ + signalsLastUpdated", async () => {
    const res = await request(app)
      .post("/api/compiq/search")
      .send({ query: "2021 Topps Chrome Mike Trout" });
    expect(res.status).toBe(200);
    expectPredictionFieldsPropagated(res.body);
  });

  it("/api/compiq/price propagates predictedPrice + trendIQ + signalsLastUpdated", async () => {
    const res = await request(app)
      .post("/api/compiq/price")
      .send({ query: "2021 Topps Chrome Mike Trout" });
    expect(res.status).toBe(200);
    expectPredictionFieldsPropagated(res.body);
  });

  it("/api/compiq/price-by-id propagates predictedPrice + trendIQ + signalsLastUpdated", async () => {
    const res = await request(app)
      .post("/api/compiq/price-by-id")
      .send({ cardHedgeCardId: "fixture-card-id" });
    expect(res.status).toBe(200);
    expectPredictionFieldsPropagated(res.body);
  });

  it("/api/compiq/bulk propagates predictedPrice + trendIQ + signalsLastUpdated per item", async () => {
    const res = await request(app)
      .post("/api/compiq/bulk")
      .send({ queries: ["2021 Topps Chrome Mike Trout"] });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].status).toBe("ok");
    expectPredictionFieldsPropagated(res.body.results[0].data);
  });
});

// CF-CH-RESPONSE-SURFACE-GRADED-ESTIMATES (2026-06-27) — wire-shape
// parity tests for the gradedEstimates field across all priced routes.
//
// PRIOR-CF GAP: /price-by-id has shipped gradedEstimates since
// CF-GRADED-PRICE-PROJECTION Phase 2 (2026-06-13), but /search and
// /price (the free-text routes) silently dropped the field from their
// response shape. Live observation: searching "2017 Topps Chrome
// Aaron Judge" via DashboardView (which hits /search) returned a
// payload with no gradedEstimates key — iOS rail rendered empty even
// though the underlying card had populated graded estimates available.
//
// THIS FILE PINS THE WIRE CONTRACT — gradedEstimates is always present
// (key-present invariant) on every priced response:
//   1. Full priced branches emit the compileGradedEstimatesForCard
//      result when est carries a cardIdentity.cardId AND the pricing
//      lookup succeeds.
//   2. Thin-null branches emit `gradedEstimates: []` (empty array, not
//      missing key) so iOS decoder has a stable contract.
//
// Mirrors compiqRouteSubBlockSurface.test.ts and compiqRoutePredictionShape
// test.ts. The three files together pin the FULL response surface.

import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.COMPIQ_CORPUS_DISABLED = "1";

const POPULATED_GRADED_ESTIMATE = {
  gradeCompany: "PSA",
  gradeValue: 10,
  fairMarketValue: null,
  confidenceTier: "estimate",
  ratioSource: "card",
  ratio: 8.5,
  basis: { method: "ratio", anchor: "raw-median", anchorValue: 152 },
  estimatedValue: 1292,
};

// CardHedge-served est WITH populated cardIdentity + gradedEstimates path.
// We mock both computeEstimate AND the helpers it calls so the wire-shape
// test exercises the route's actual assembly logic.
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

vi.mock("../src/services/compiq/compileGradedEstimatesForCard.js", async () => {
  return {
    compileGradedEstimatesForCard: vi.fn(async () => ({
      estimates: [POPULATED_GRADED_ESTIMATE],
      mutationDetected: false,
    })),
  };
});

vi.mock("../src/services/compiq/compiqEstimate.service.js", async () => {
  const actual = await vi.importActual<any>("../src/services/compiq/compiqEstimate.service.js");
  return {
    ...actual,
    computeEstimate: vi.fn(async () => ({
      fairMarketValue: 152,
      premiumValue: 175,
      quickSaleValue: 134,
      marketDNA: { trend: "up", speed: "Normal" },
      confidence: { pricingConfidence: 75 },
      source: "live",
      verdict: "Hold",
      compsUsed: 35,
      compsAvailable: 35,
      recentComps: [],
      cardIdentity: { card_id: "fixture-card-id-2017-judge" },
      gradeUsed: "Raw",
      daysSinceNewestComp: 0,
      variantWarning: [],
      neighborSynthesis: null,
      crossParallelAnchor: null,
      effectiveFmv: 152,
      lastSale: { price: 152, soldDate: "2026-06-26T00:00:00.000Z" },
      estimateSource: "observed",
      estimatedValue: 152,
      estimateRange: [140, 165],
      estimateBasis: "comps-direct",
    })),
  };
});

// Bypass the actual getPricing lookup; return a payload that signals
// "not notFound" so the assembly block proceeds into
// compileGradedEstimatesForCard. The mock for compileGradedEstimatesForCard
// above controls what flows back.
//
// CF-CARDIDENTITY-FIELD-CASE-FIX (2026-06-29): the route imports
// `getPricing` from catalogSource.js (aliased as getPricingForMarketRead
// at compiq.routes.ts line 35), NOT from marketRead.service.js. The
// prior test mocked marketRead.service.js so the mock never applied —
// real getPricing ran, hit network-disabled fetch, threw, caught → empty
// gradedEstimates. Mocking catalogSource.js now exercises the real code
// path properly.
vi.mock("../src/services/compiq/catalogSource.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getPricing: vi.fn(async () => ({
      notFound: false,
      card: { id: "fixture-card-id-2017-judge" },
      sales: [],
    })),
  };
});

vi.mock("../src/services/compiq/marketRead.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    buildGradeBreakdown: vi.fn(() => []),
    generateMarketRead: vi.fn(async () => null),
    pickCardImageUrl: vi.fn(() => null),
  };
});

let app: any;

beforeAll(async () => {
  app = (await import("../src/app")).default;
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

function expectGradedEstimatesKeyPresent(body: any) {
  expect(
    Object.prototype.hasOwnProperty.call(body, "gradedEstimates"),
    "gradedEstimates key must be PRESENT on the response (even when empty)",
  ).toBe(true);
  expect(Array.isArray(body.gradedEstimates)).toBe(true);
}

describe("CF-CH-RESPONSE-SURFACE-GRADED-ESTIMATES — gradedEstimates rail propagates through every priced route", () => {
  it("/api/compiq/search carries gradedEstimates from compileGradedEstimatesForCard", async () => {
    const res = await request(app)
      .post("/api/compiq/search")
      .set("x-session-id", "test-sess")
      .send({ query: "2017 Topps Chrome Aaron Judge" });
    expect(res.status).toBe(200);
    expectGradedEstimatesKeyPresent(res.body);
    expect(res.body.gradedEstimates.length).toBeGreaterThan(0);
    expect(res.body.gradedEstimates[0]).toEqual(POPULATED_GRADED_ESTIMATE);
  });

  it("/api/compiq/price carries gradedEstimates from compileGradedEstimatesForCard", async () => {
    const res = await request(app)
      .post("/api/compiq/price")
      .set("x-session-id", "test-sess")
      .send({ query: "2017 Topps Chrome Aaron Judge" });
    expect(res.status).toBe(200);
    expectGradedEstimatesKeyPresent(res.body);
    expect(res.body.gradedEstimates.length).toBeGreaterThan(0);
    expect(res.body.gradedEstimates[0]).toEqual(POPULATED_GRADED_ESTIMATE);
  });

  it("/api/compiq/price-by-id continues to carry gradedEstimates (no regression on existing path)", async () => {
    const res = await request(app)
      .post("/api/compiq/price-by-id")
      .set("x-session-id", "test-sess")
      .send({ cardId: "fixture-card-id-2017-judge" });
    expect(res.status).toBe(200);
    expectGradedEstimatesKeyPresent(res.body);
  });
});

describe("CF-CH-RESPONSE-SURFACE-GRADED-ESTIMATES — key-present invariant when compileGradedEstimatesForCard yields empty", () => {
  beforeEach(async () => {
    const helper = await import("../src/services/compiq/compileGradedEstimatesForCard.js");
    (helper.compileGradedEstimatesForCard as any).mockImplementation(async () => ({
      estimates: [],
      mutationDetected: false,
    }));
  });

  it("/api/compiq/search emits gradedEstimates: [] when assembly produces nothing", async () => {
    // Unique query per test prevents cache-key collision with prior
    // describe block (route is cacheWrap-ed at 6h TTL; first successful
    // call would otherwise return cached gradedEstimates).
    const res = await request(app)
      .post("/api/compiq/search")
      .set("x-session-id", "test-sess")
      .send({ query: "EMPTY-CASE-001 Aaron Judge" });
    expect(res.status).toBe(200);
    expectGradedEstimatesKeyPresent(res.body);
    expect(res.body.gradedEstimates).toEqual([]);
  });

  it("/api/compiq/price emits gradedEstimates: [] when assembly produces nothing", async () => {
    const res = await request(app)
      .post("/api/compiq/price")
      .set("x-session-id", "test-sess")
      .send({ query: "EMPTY-CASE-002 Aaron Judge" });
    expect(res.status).toBe(200);
    expectGradedEstimatesKeyPresent(res.body);
    expect(res.body.gradedEstimates).toEqual([]);
  });
});

describe("CF-CH-RESPONSE-SURFACE-GRADED-ESTIMATES — assembly failure is non-fatal, response shape stays stable", () => {
  beforeEach(async () => {
    const helper = await import("../src/services/compiq/compileGradedEstimatesForCard.js");
    (helper.compileGradedEstimatesForCard as any).mockImplementation(async () => {
      throw new Error("simulated assembly failure");
    });
  });

  it("/api/compiq/search emits gradedEstimates: [] when compileGradedEstimatesForCard throws", async () => {
    const res = await request(app)
      .post("/api/compiq/search")
      .set("x-session-id", "test-sess")
      .send({ query: "THROW-CASE-001 Aaron Judge" });
    expect(res.status).toBe(200);
    expectGradedEstimatesKeyPresent(res.body);
    expect(res.body.gradedEstimates).toEqual([]);
  });

  it("/api/compiq/price emits gradedEstimates: [] when compileGradedEstimatesForCard throws", async () => {
    const res = await request(app)
      .post("/api/compiq/price")
      .set("x-session-id", "test-sess")
      .send({ query: "THROW-CASE-002 Aaron Judge" });
    expect(res.status).toBe(200);
    expectGradedEstimatesKeyPresent(res.body);
    expect(res.body.gradedEstimates).toEqual([]);
  });
});

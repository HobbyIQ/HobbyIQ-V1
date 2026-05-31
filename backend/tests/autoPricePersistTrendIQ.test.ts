// CF-AUTOPRICE-PERSIST-TRENDIQ — verifies that both persistence sites
// (autoPriceHolding via addHolding, repriceHoldingsForUser via batch reprice)
// extract trendIQ movement fields from the estimate response and write them
// onto the stored holding doc. Same lesson as CF-PREDICTION-LAYER-
// CONSISTENCY-COMPLETION: two persistence sites, both must be exercised.

import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import { readUserDoc } from "../src/services/portfolioiq/portfolioStore.service.js";

process.env.COMPIQ_CORPUS_DISABLED = "1";
// Effectively disable the batch-reprice freshness gate + per-user throttle
// for the reprice-site test below. autoPriceHolding (called by addHolding
// seed) sets a fresh lastUpdated; without these overrides the subsequent
// /reprice/batch call would skip the freshly-priced holding. Note: "0" is
// treated as falsy by the runBatchReprice `|| 60_000` fallback, so we use
// "1" (millisecond) which truthy-passes through and lets the gate trivially
// admit any holding older than 1ms.
process.env.PORTFOLIO_REPRICE_HTTP_MIN_AGE_MS = "1";
process.env.PORTFOLIO_REPRICE_HTTP_THROTTLE_MS = "1";

const NOW_ISO_FIXED = "2026-05-27T20:00:00.000Z";

// Mock computeEstimate at the module level so BOTH persistence sites
// (addHolding → autoPriceHolding, /reprice/batch → repriceHoldingsForUser)
// see the same canonical estimate response.
vi.mock("../src/services/compiq/compiqEstimate.service.js", async () => {
  const actual = await vi.importActual<any>("../src/services/compiq/compiqEstimate.service.js");
  return {
    ...actual,
    // Default mock: live success path with full TrendIQ. Individual tests
    // override via mockImplementationOnce when they need fallback shapes.
    computeEstimate: vi.fn(async () => ({
      fairMarketValue: 100,
      premiumValue: 115,
      quickSaleValue: 88,
      marketDNA: { trend: "up", speed: "Normal", marketCondition: "Balanced Market" },
      confidence: { pricingConfidence: 75 },
      source: "live",
      verdict: "Hold",
      action: "Hold",
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
        lastUpdated: NOW_ISO_FIXED,
        coverage: "full",
        components: {
          playerMomentum: null,
          cardTrajectory: null,
          segmentTrajectory: null,
        },
        weights: { playerMomentum: 1, cardTrajectory: 0, segmentTrajectory: 0 },
      },
      signalsLastUpdated: NOW_ISO_FIXED,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(): Promise<{ sessionId: string; userId: string }> {
  const res = await request(app)
    .post("/api/auth/signin")
    .send({ username: "HobbyIQ", password: "Baseball25" });
  expect(res.status).toBe(200);
  expect(res.body.sessionId).toBeTruthy();
  return {
    sessionId: res.body.sessionId as string,
    userId: res.body.user?.userId as string,
  };
}

// CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase B: read storage directly via
// readUserDoc instead of through GET /api/portfolio/holdings/:id. The
// portfolio wire (post Phase B anti-corruption layer) intentionally omits
// β fields like movementComposite / movementImpliedPct / movementCoverage;
// these tests verify the WRITER persists them and therefore must observe
// raw storage, not the wire shape.
async function getHoldingFromStore(
  userId: string,
  holdingId: string,
): Promise<any | null> {
  const doc = await readUserDoc(userId);
  return doc.holdings[holdingId] ?? null;
}

describe("CF-AUTOPRICE-PERSIST-TRENDIQ — autoPriceHolding (site 1, via addHolding)", () => {
  it("persists 5 movement fields from trendIQ when computeEstimate returns it", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = `movement-test-add-${Date.now()}`;
    const addRes = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", sessionId)
      .send({
        id: holdingId,
        playerName: "Mike Trout",
        cardYear: 2021,
        product: "Topps Chrome",
        quantity: 1,
        purchasePrice: 50,
        totalCostBasis: 50,
      });
    expect(addRes.status).toBe(201);

    const stored = await getHoldingFromStore(userId, holdingId);
    expect(stored).not.toBeNull();
    expect(stored.movementDirection).toBe("up");
    expect(stored.movementUpdatedAt).toBe(NOW_ISO_FIXED);
    // CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase C: movementComposite /
    // movementImpliedPct / movementCoverage are β detail-only and no
    // longer persisted on the holding. They remain available on
    // POST /api/compiq/* via the estimate response's trendIQ.
  });

  it("leaves movement fields null when computeEstimate returns no trendIQ (fallback path)", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = `movement-test-fallback-${Date.now()}`;

    // Reach back into the mocked service and shadow next call with a
    // fallback-shape estimate (no trendIQ field).
    const compiqEstimateService = await import("../src/services/compiq/compiqEstimate.service.js");
    (compiqEstimateService.computeEstimate as any).mockImplementationOnce(async () => ({
      fairMarketValue: 100,
      premiumValue: 115,
      quickSaleValue: 88,
      marketDNA: { trend: "flat", speed: "Normal", marketCondition: "Balanced Market" },
      confidence: { pricingConfidence: 70 },
      source: "variant-mismatch",
      verdict: "Variant mismatch",
      action: "Hold",
      compsUsed: 5,
      compsAvailable: 5,
      recentComps: [],
      cardIdentity: { cardId: "fixture-card-id-fallback" },
      gradeUsed: "Raw",
      daysSinceNewestComp: 3,
      variantWarning: ["variant-mismatch"],
      effectiveFmv: 100,
      // No predictedPrice, no trendIQ — fallback path.
      predictedPrice: null,
      predictedPriceRange: null,
      predictedPriceAttribution: { mechanism: "multiplier-anchored" },
      // trendIQ field intentionally omitted.
      signalsLastUpdated: null,
    }));

    const addRes = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", sessionId)
      .send({
        id: holdingId,
        playerName: "Mystery Player",
        cardYear: 2024,
        product: "Bowman Chrome",
        parallel: "Blue",
        quantity: 1,
        purchasePrice: 50,
        totalCostBasis: 50,
      });
    expect(addRes.status).toBe(201);

    const stored = await getHoldingFromStore(userId, holdingId);
    expect(stored).not.toBeNull();
    expect(stored.movementDirection ?? null).toBeNull();
    expect(stored.movementComposite ?? null).toBeNull();
    expect(stored.movementImpliedPct ?? null).toBeNull();
    expect(stored.movementCoverage ?? null).toBeNull();
    expect(stored.movementUpdatedAt ?? null).toBeNull();
  });
});

describe("CF-AUTOPRICE-PERSIST-TRENDIQ — repriceHoldingsForUser (site 2, via /reprice/batch)", () => {
  it("persists 5 movement fields when batch reprice fires for a holding with trendIQ", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = `movement-test-reprice-${Date.now()}`;

    // Seed the holding with a fallback-shape estimate (no trendIQ) so the
    // initial autoPriceHolding write leaves movement fields null. Then the
    // reprice call's distinct "down" mock proves the SECOND persistence
    // site picked up the new movement values, isolated from site 1.
    const compiqEstimateService = await import("../src/services/compiq/compiqEstimate.service.js");
    (compiqEstimateService.computeEstimate as any).mockImplementationOnce(async () => ({
      fairMarketValue: 25,
      premiumValue: 28,
      quickSaleValue: 22,
      marketDNA: { trend: "flat", speed: "Normal", marketCondition: "Balanced Market" },
      confidence: { pricingConfidence: 70 },
      source: "live",
      verdict: "Hold",
      action: "Hold",
      compsUsed: 3,
      compsAvailable: 4,
      recentComps: [],
      cardIdentity: { cardId: "fixture-bwj-seed" },
      gradeUsed: "Raw",
      daysSinceNewestComp: 5,
      variantWarning: [],
      effectiveFmv: 25,
      // No trendIQ → movement fields land null on initial autoPriceHolding write.
      predictedPrice: null,
      predictedPriceRange: null,
      predictedPriceAttribution: { mechanism: "unavailable" },
      signalsLastUpdated: null,
    }));

    const addRes = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", sessionId)
      .send({
        id: holdingId,
        playerName: "Bobby Witt Jr",
        cardYear: 2020,
        product: "Bowman Chrome",
        quantity: 1,
        purchasePrice: 25,
        totalCostBasis: 25,
      });
    expect(addRes.status).toBe(201);

    // Verify pre-reprice state — movement fields null per the seed mock.
    const preReprice = await getHoldingFromStore(userId, holdingId);
    expect(preReprice).not.toBeNull();
    expect(preReprice.movementDirection ?? null).toBeNull();

    // Override ALL subsequent estimate calls with a "down" direction so
    // the reprice loop (which iterates over every holding in the doc —
    // potentially multiple from prior tests in this file) gets the same
    // override regardless of holding count. mockImplementation (not Once)
    // sticks until restored below.
    (compiqEstimateService.computeEstimate as any).mockImplementation(async () => ({
      fairMarketValue: 13,
      premiumValue: 15,
      quickSaleValue: 11,
      marketDNA: { trend: "down", speed: "Normal", marketCondition: "Balanced Market" },
      confidence: { pricingConfidence: 80 },
      source: "live",
      verdict: "Hold",
      action: "Hold",
      compsUsed: 4,
      compsAvailable: 5,
      recentComps: [],
      cardIdentity: { cardId: "fixture-card-id-bwj" },
      gradeUsed: "Raw",
      daysSinceNewestComp: 2,
      variantWarning: [],
      effectiveFmv: 13,
      predictedPrice: 12.5,
      predictedPriceRange: { low: 11.5, high: 13.5 },
      predictedPriceAttribution: { mechanism: "trendiq-projection" },
      trendIQ: {
        composite: 0.92,
        direction: "down",
        impliedPct: -8.0,
        lastUpdated: NOW_ISO_FIXED,
        coverage: "no_segment",
        components: { playerMomentum: null, cardTrajectory: null, segmentTrajectory: null },
        weights: { playerMomentum: 0.30, cardTrajectory: 0.70, segmentTrajectory: 0 },
      },
      signalsLastUpdated: NOW_ISO_FIXED,
    }));

    const repriceRes = await request(app)
      .post("/api/portfolio/reprice/batch")
      .set("x-session-id", sessionId)
      .send({});
    expect(repriceRes.status).toBe(200);
    // Sanity: the reprice must have actually examined+repriced our holding.
    // If it skipped (throttle, fresh, confidence-gate), the test below would
    // fail with movementDirection=null because the second mock was unused.
    const targetUpdate = (repriceRes.body.updates ?? []).find(
      (u: any) => u.id === holdingId,
    );
    expect(targetUpdate, `reprice did not touch holding ${holdingId}; full body: ${JSON.stringify(repriceRes.body)}`).toBeDefined();
    expect(targetUpdate.status, `reprice status for ${holdingId}: ${JSON.stringify(targetUpdate)}`).toBe("repriced");

    const stored = await getHoldingFromStore(userId, holdingId);
    expect(stored).not.toBeNull();
    expect(stored.movementDirection).toBe("down");
    expect(stored.movementUpdatedAt).toBe(NOW_ISO_FIXED);
    // CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase C: see addHolding-site comment above.
  });
});

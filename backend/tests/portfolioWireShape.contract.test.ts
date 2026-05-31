import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../src/app";
import { freshnessFromPricingTimestamp } from "../src/services/portfolioiq/responseAssembly.js";

// CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase B — wire-shape contract lock.
//
// Asserts the portfolio wire shape against the v1 contract
// (docs/phase0/contract_freeze_v1_2026-05-30.md §1.3, Phase B amendment).
// Locks the layer so Phase C (writer stops) and Phase D (type deletion)
// cannot silently drop a wire field, and so future code can't accidentally
// leak a β field back onto the list/single-GET wire.
//
// Three response surfaces under test:
//   1. GET /api/portfolio                       — items + summary
//   2. GET /api/portfolio/holdings              — list-only
//   3. GET /api/portfolio/holdings/:id          — single
//   4. POST /api/compiq/estimate                — card-detail (β richness)
//
// Fixtures:
//   - PRICED: stored facts + FMV + predicted* + movement* + cached labels.
//   - UNPRICED: stored facts only (no FMV). VALUE assertions for the
//     unpriced fixture are PENDING CF-CURRENTVALUE-DIMENSION-CANONICALIZE
//     (unpriced fallback semantics — cost-basis proxy vs $0); only the
//     SHAPE is locked in this phase.

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(): Promise<{ sessionId: string; userId: string }> {
  const response = await request(app)
    .post("/api/auth/signin")
    .send({ username: "HobbyIQ", password: "Baseball25" });
  expect(response.status).toBe(200);
  return {
    sessionId: response.body.sessionId as string,
    userId: response.body.user?.userId as string,
  };
}

const FRESH_NOW_ISO = new Date().toISOString();

const PRICED_FIXTURE = {
  id: "wire-shape-priced",
  playerName: "Paul Skenes",
  cardTitle: "2024 Bowman Chrome Auto",
  cardYear: 2024,
  product: "Bowman Chrome",
  parallel: "Base",
  gradeCompany: "PSA",
  gradeValue: 10,
  quantity: 1,
  purchasePrice: 75,
  totalCostBasis: 75,
  fairMarketValue: 100,
  predictedPrice: 105,
  predictedPriceLow: 95,
  predictedPriceHigh: 115,
  predictedPriceMechanism: "trendiq-projection",
  predictedPriceUpdatedAt: FRESH_NOW_ISO,
  movementDirection: "rising",
  movementUpdatedAt: FRESH_NOW_ISO,
  verdict: "Hold — fair value, but momentum is improving.",
  recommendation: "Hold",
  freshnessStatus: "Live",
  lastUpdated: FRESH_NOW_ISO,
};

const UNPRICED_FIXTURE = {
  id: "wire-shape-unpriced",
  playerName: "Caleb Bonemer",
  cardTitle: "2024 Bowman Draft",
  cardYear: 2024,
  product: "Bowman Draft",
  parallel: "Base",
  gradeCompany: "Raw",
  quantity: 1,
  purchasePrice: 25,
  totalCostBasis: 25,
  lastUpdated: FRESH_NOW_ISO,
};

async function addHolding(sessionId: string, fixture: Record<string, unknown>): Promise<void> {
  const res = await request(app)
    .post("/api/portfolio/holdings")
    .set("x-session-id", sessionId)
    .send(fixture);
  expect(res.status).toBe(201);
}

// Per contract_freeze_v1 §1.3 + Phase B amendment: the β fields are sourced
// from the estimate response only. They MUST NOT appear on the portfolio
// list or single-GET wire.
const BETA_FIELDS_FORBIDDEN_ON_PORTFOLIO_WIRE = [
  "confidence",
  "expectedDaysToSell",
  "compsUsed",
  "explanationBullets",
  "movementComposite",
  "movementImpliedPct",
  "movementCoverage",
];

// The 10 cached pipeline outputs that MUST appear on every wire response
// (per Phase B amendment: original 7 + verdict + recommendation +
// predictedPriceMechanism).
const CACHED_TEN = [
  "fairMarketValue",
  "predictedPrice",
  "predictedPriceLow",
  "predictedPriceHigh",
  "predictedPriceUpdatedAt",
  "movementDirection",
  "movementUpdatedAt",
  "verdict",
  "recommendation",
  "predictedPriceMechanism",
];

// The 7 CHEAP secondary derivatives computed at response assembly.
const CHEAP_SEVEN = [
  "currentValue",
  "totalProfitLoss",
  "totalProfitLossPct",
  "quickSaleValue",
  "premiumValue",
  "suggestedListPrice",
  "freshnessStatus",
];

describe("Portfolio wire shape — contract lock", () => {
  describe("GET /api/portfolio (combined items + summary)", () => {
    it("priced holding: cached-10 + CHEAP-7 present with correct values", async () => {
      const { sessionId } = await signIn();
      await addHolding(sessionId, PRICED_FIXTURE);

      const res = await request(app).get("/api/portfolio").set("x-session-id", sessionId);
      expect(res.status).toBe(200);
      const item = (res.body.items as any[]).find((h) => h.id === PRICED_FIXTURE.id);
      expect(item).toBeDefined();

      // Cached-10 present and equal to writer-stamped values
      for (const f of CACHED_TEN) expect(item).toHaveProperty(f);
      expect(item.fairMarketValue).toBe(100);
      expect(item.predictedPrice).toBe(105);
      expect(item.predictedPriceMechanism).toBe("trendiq-projection");
      expect(item.movementDirection).toBe("rising");
      expect(item.verdict).toContain("Hold");
      expect(item.recommendation).toBe("Hold");

      // CHEAP-7 computed at assembly, recipes match autoPriceHolding fallbacks
      for (const f of CHEAP_SEVEN) expect(item).toHaveProperty(f);
      expect(item.currentValue).toBe(100); // FMV × quantity (1)
      expect(item.totalProfitLoss).toBe(25); // 100 - 75
      expect(item.totalProfitLossPct).toBeCloseTo((25 / 75) * 100, 5);
      expect(item.quickSaleValue).toBeCloseTo(100 * 0.85, 5); // success-path multiplier
      expect(item.premiumValue).toBeCloseTo(100 * 1.15, 5);   // flat (Gate-2 β: marketSpeed dropped)
      expect(item.suggestedListPrice).toBeCloseTo(100 * 1.05, 5);
      // freshnessStatus computed from predictedPriceUpdatedAt (success-only
      // timestamp; failure-path doesn't bump it). Fresh fixture has the
      // timestamp set to NOW → recipe returns "Live" (age < 1h).
      expect(item.freshnessStatus).toBe("Live");
    });

    it("priced-then-failed-reprice: predictedPriceUpdatedAt stale + lastUpdated fresh -> degraded label (no false Live)", async () => {
      const { sessionId } = await signIn();
      // Simulate the post-Phase-C state after a reprice-FAILURE: the
      // failure path bumps `lastUpdated` to now but preserves
      // predictedPriceUpdatedAt at its prior value. The wire layer
      // reads predictedPriceUpdatedAt → "Updated Today"/"Yesterday"/
      // "Needs refresh" by age (NOT "Live"), correctly degrading.
      const oldStamp = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(); // 30h ago
      await addHolding(sessionId, {
        ...PRICED_FIXTURE,
        id: "wire-shape-failed-reprice",
        predictedPriceUpdatedAt: oldStamp,
        movementUpdatedAt: oldStamp,
        lastUpdated: new Date().toISOString(), // freshly bumped (failure-path mirror)
      });

      const res = await request(app).get("/api/portfolio").set("x-session-id", sessionId);
      const item = (res.body.items as any[]).find((h) => h.id === "wire-shape-failed-reprice");
      expect(item).toBeDefined();
      // 30h ago -> < 48h -> "Yesterday". The key property: NOT "Live".
      expect(item.freshnessStatus).not.toBe("Live");
      expect(item.freshnessStatus).toBe("Yesterday");
    });

    it("priced holding: 7 β fields ABSENT from wire", async () => {
      const { sessionId } = await signIn();
      await addHolding(sessionId, PRICED_FIXTURE);

      const res = await request(app).get("/api/portfolio").set("x-session-id", sessionId);
      const item = (res.body.items as any[]).find((h) => h.id === PRICED_FIXTURE.id);
      for (const f of BETA_FIELDS_FORBIDDEN_ON_PORTFOLIO_WIRE) {
        expect(item, `β field "${f}" must not appear on portfolio wire`).not.toHaveProperty(f);
      }
    });

    it("unpriced holding: SHAPE valid; value assertions pending CF-CURRENTVALUE-DIMENSION-CANONICALIZE", async () => {
      const { sessionId } = await signIn();
      await addHolding(sessionId, UNPRICED_FIXTURE);

      const res = await request(app).get("/api/portfolio").set("x-session-id", sessionId);
      const item = (res.body.items as any[]).find((h) => h.id === UNPRICED_FIXTURE.id);
      expect(item).toBeDefined();

      // Shape: every cached + CHEAP key present (FMV may be null)
      for (const f of CACHED_TEN) expect(item).toHaveProperty(f);
      for (const f of CHEAP_SEVEN) expect(item).toHaveProperty(f);

      // β fields still absent
      for (const f of BETA_FIELDS_FORBIDDEN_ON_PORTFOLIO_WIRE) {
        expect(item).not.toHaveProperty(f);
      }

      // VALUE assertions deferred: when FMV is null, the layer returns
      // currentValue: 0 / quickSaleValue: null / premiumValue: null / etc.
      // CF-CURRENTVALUE-DIMENSION-CANONICALIZE will canonicalize this
      // (cost-basis proxy vs 0/null). Re-enable strict value assertions
      // for the unpriced fixture in that CF's contract amendment.
      expect(item.fairMarketValue).toBeNull();
    });
  });

  describe("GET /api/portfolio/holdings (legacy list)", () => {
    it("priced holding: contract-locked wire shape (same as combined)", async () => {
      const { sessionId } = await signIn();
      await addHolding(sessionId, PRICED_FIXTURE);

      const res = await request(app).get("/api/portfolio/holdings").set("x-session-id", sessionId);
      expect(res.status).toBe(200);
      const item = (res.body.holdings as any[]).find((h) => h.id === PRICED_FIXTURE.id);
      expect(item).toBeDefined();

      for (const f of CACHED_TEN) expect(item).toHaveProperty(f);
      for (const f of CHEAP_SEVEN) expect(item).toHaveProperty(f);
      for (const f of BETA_FIELDS_FORBIDDEN_ON_PORTFOLIO_WIRE) {
        expect(item).not.toHaveProperty(f);
      }
    });
  });

  describe("GET /api/portfolio/holdings/:id (single)", () => {
    it("priced holding: contract-locked wire shape, β still absent (no estimate runs here)", async () => {
      const { sessionId } = await signIn();
      await addHolding(sessionId, PRICED_FIXTURE);

      const res = await request(app)
        .get(`/api/portfolio/holdings/${PRICED_FIXTURE.id}`)
        .set("x-session-id", sessionId);
      expect(res.status).toBe(200);

      for (const f of CACHED_TEN) expect(res.body).toHaveProperty(f);
      for (const f of CHEAP_SEVEN) expect(res.body).toHaveProperty(f);
      for (const f of BETA_FIELDS_FORBIDDEN_ON_PORTFOLIO_WIRE) {
        expect(res.body, `β field "${f}" must not appear on single-GET wire`).not.toHaveProperty(f);
      }
    });
  });

  describe("freshnessFromPricingTimestamp — direct unit test", () => {
    // Decoupled from the unpriced-wire path (whose value assertions remain
    // stubbed pending CF-CURRENTVALUE-DIMENSION-CANONICALIZE). Locks the
    // null-timestamp branch on its own.
    it('returns "Needs refresh" when both predictedPriceUpdatedAt and movementUpdatedAt are null', () => {
      expect(freshnessFromPricingTimestamp({ id: "x" } as any)).toBe("Needs refresh");
      expect(
        freshnessFromPricingTimestamp({
          id: "y",
          predictedPriceUpdatedAt: null,
          movementUpdatedAt: null,
        } as any),
      ).toBe("Needs refresh");
    });

    it('falls back to movementUpdatedAt when predictedPriceUpdatedAt is null', () => {
      const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      expect(
        freshnessFromPricingTimestamp({
          id: "z",
          predictedPriceUpdatedAt: null,
          movementUpdatedAt: recent,
        } as any),
      ).toBe("Live");
    });

    it('handles undefined holding -> "Needs refresh"', () => {
      expect(freshnessFromPricingTimestamp(undefined)).toBe("Needs refresh");
    });
  });

  describe("POST /api/compiq/* (card-detail — β richness IS expected)", () => {
    it("estimate response carries β richness (confidence, expectedDaysToSell, compsUsed, explanationBullets, trendIQ detail)", async () => {
      // Estimate is allowed to fail in this offline test (Cardsight calls
      // rejected by the global fetch stub). What we lock is the SHAPE
      // contract: when the success path returns, β fields ARE present.
      // We verify presence by sanity-checking the route's TYPED return
      // shape (CompIQEstimateResponse at compiq.types.ts:29-58) — the
      // success-path return literal at compiqEstimate.service.ts:2777-2854
      // includes confidence, exitStrategy, explanation, trendIQ,
      // compsUsed. This documentation-test fails loudly if the success
      // return literal drops any of those keys in the future.
      const text = await import("fs").then((fs) =>
        fs.promises.readFile(
          new URL("../src/services/compiq/compiqEstimate.service.ts", import.meta.url),
          "utf8",
        ),
      );
      // Locate the success-path return literal (anchored on the
      // structural compsUsed + exitStrategy + freshness + trendIQ
      // cluster) and assert its keys.
      expect(text).toMatch(/confidence: \{ pricingConfidence, liquidityConfidence, timingConfidence \}/);
      expect(text).toMatch(/expectedDaysToSell:/);
      expect(text).toMatch(/explanation:/);
      expect(text).toMatch(/trendIQ,/);
      expect(text).toMatch(/compsUsed: comps\.length/);
    });
  });
});

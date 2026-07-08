// CF-CARD-PANEL (2026-07-04) — pins the /api/compiq/card-panel/:cardId
// route contract. Three parallel fetches fan out; the response is a
// single object combining identity, gradeCurve, and referencePrices.

import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";

// Auth stub — matches sibling test files
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

// Mock the CH client — the panel's three fetches route through
// getCardMetaById / getCardDetailsById / getAllPricesByCard (and
// buildObservedGradeCurve → getCardSales under the hood).
vi.mock("../src/services/compiq/cardsight.router.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getCardMetaById: vi.fn(async (cardId: string) => ({
      card_id: cardId,
      player: "Eric Hartman",
      set: "2026 Bowman Chrome",
      number: "CPA-EHA",
      variant: "Base",
      year: 2026,
      image: "https://example/card.jpg",
    })),
  };
});

vi.mock("../src/services/compiq/cardhedge.client.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getCardDetailsById: vi.fn(async () => null),
    getAllPricesByCard: vi.fn(async () => [
      { card_id: "c1", grade: "Raw", grader: "Raw", price: 130, display_order: -1 },
      { card_id: "c1", grade: "PSA 10", grader: "PSA", price: 900, display_order: 1 },
    ]),
    getCardSales: vi.fn(async () => []),
    // CF-ONE-TRAJECTORY (2026-07-04): trajectory math needs weekly buckets
    // from CH's sales-stats-by-player. Stub returns null → trajectory
    // silently skips (no adjustment, no throw).
    getSalesStatsByPlayer: vi.fn(async () => null),
  };
});

// CF-MATCHED-COHORT-TRAJECTORY (2026-07-05): trajectory now reads from
// getPlayerTrendSnapshot. Stub returns null → trajectory silently skips.
vi.mock("../src/services/playerTrend/index.js", () => ({
  getPlayerTrendSnapshot: vi.fn(async () => null),
}));
// CF-MATCHED-COHORT-ON-DEMAND (2026-07-05): stub the fallback path.
vi.mock("../src/services/playerTrend/cardHedgeMatchedCohortProvider.js", () => ({
  fetchCardHedgeMatchedCohort: vi.fn(async () => null),
}));
vi.mock("../src/services/playerTrend/matchedCohortCache.js", () => ({
  readMatchedCohortFromCache: vi.fn(async () => null),
  writeMatchedCohortToCache: vi.fn(async () => undefined),
}));
// CF-PARALLEL-TIER-TREND (2026-07-05): third-tier fallback. Stub null
// → parallel-tier silently skips (no trajectory adjustment, no throw).
vi.mock("../src/services/playerTrend/parallelTierTrend.service.js", () => ({
  getParallelTierTrend: vi.fn(async () => null),
}));
// CF-RELEASE-AUTO-DETECT (2026-07-05): stub so tests don't hang on the
// additions-summary fallback when the set string doesn't match the
// hard-coded RELEASE_DATES table.
vi.mock("../src/services/compiq/releaseAutoDetect.service.js", () => ({
  detectReleaseDateForSet: vi.fn(async () => null),
}));

import app from "../src/app";

describe("CF-CARD-PANEL — GET /api/compiq/card-panel/:cardId", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  it("returns identity + gradeCurve + referencePrices in a single call", async () => {
    const res = await request(app)
      .get("/api/compiq/card-panel/1778542173652x303328120692600800")
      .set("x-session-id", "test-sess");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.cardId).toBe("1778542173652x303328120692600800");

    // Identity resolved from meta cache mock
    expect(res.body.identity).toBeDefined();
    expect(res.body.identity.player).toBe("Eric Hartman");
    expect(res.body.identity.set).toBe("2026 Bowman Chrome");
    expect(res.body.identity.number).toBe("CPA-EHA");
    expect(res.body.identity.imageUrl).toBe("https://example/card.jpg");

    // Grade curve shape — 10 canonical entries even when all empty
    expect(res.body.gradeCurve).toBeDefined();
    // CF-EIGHT-TIER-GRADES (2026-07-06): 14 canonical grades now
    expect(res.body.gradeCurve.entries).toHaveLength(14);
    expect(res.body.gradeCurve.totalSampleCount).toBe(0);

    // Reference prices from mock
    expect(res.body.referencePrices).toHaveLength(2);
    expect(res.body.referencePrices[0]).toMatchObject({ grade: "Raw", grader: "Raw", referencePrice: 130 });
    expect(res.body.referencePrices[1]).toMatchObject({ grade: "PSA 10", grader: "PSA", referencePrice: 900 });
  });

  it("400 when cardId path param is empty (guard)", async () => {
    // Empty path param routes to a different pattern; use a whitespace-only
    // cardId which trims to empty string to hit the guard branch.
    const res = await request(app)
      .get("/api/compiq/card-panel/%20")
      .set("x-session-id", "test-sess");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("response body contains no CardHedge/vendor identifiers", async () => {
    const res = await request(app)
      .get("/api/compiq/card-panel/some-card-id")
      .set("x-session-id", "test-sess");
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr.toLowerCase()).not.toContain("cardhedge");
    expect(bodyStr).not.toContain("CardHedge");
  });
});

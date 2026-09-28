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
    // CF-SAME-PLAYER-SIBLINGS (2026-07-08): the /card-panel route now
    // also runs a same-player siblings search. Stub returns [] so the
    // sibling carousel is empty in tests (route still returns cleanly).
    searchCards: vi.fn(async () => []),
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

// CF-CARD-TITLE-NEVER-DOUBLES-THE-YEAR (Drew, 2026-09-06): the route's
// hiq:-slug branch runs the one valuation path. Spy on it (actual
// implementation preserved) so a single case can drive a KNOWN identity
// through the panel's projection block without standing up a pool — every
// other case in this file keeps the real behaviour.
vi.mock("../src/services/compiq/oneValuationPath.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    valueIdentity: vi.fn(actual.valueIdentity as (...args: unknown[]) => unknown),
  };
});

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
    expect(res.body.gradeCurve.entries).toHaveLength(15);
    // CF-BGS-BLACK-LABEL-SPLIT (2026-08-22): BGS 10 Black Label is its own
    // tier and must reach the wire, not just the service.
    expect(
      res.body.gradeCurve.entries.some((e: { grade: string }) => /black label/i.test(String(e.grade))),
    ).toBe(true);
    expect(res.body.gradeCurve.totalSampleCount).toBe(0);

    // CF-KILL-VENDOR-REFERENCE-PRICES (Drew, 2026-07-13, PR #409): the wire
    // no longer emits CH-derived reference prices. `referencePrices` stays
    // on the shape as an empty array for backwards-compat with older iOS
    // decoders. The wire is now 100% engine-owned; no vendor "market read"
    // shows up here.
    expect(res.body.referencePrices).toEqual([]);
  });

  // CF-CARD-TITLE-NEVER-DOUBLES-THE-YEAR (Drew, 2026-09-06, PR #1904 +
  // the iOS follow-up).
  //
  // /card-panel re-projects wireIdentity into the panel's OLDER field
  // names, so the two additive fields PR #1904 put on the pricing wire —
  // `setName` (never year-carrying) and `displayName` (the title composed
  // once, server-side) — only reach this response because that projection
  // block copies them across by hand. tests/wireIdentityCardTitle.test.ts
  // pins wireIdentity itself; nothing pinned the hand-copy, and a field
  // dropped there is invisible to every wireIdentity test.
  //
  // iOS reads BOTH off this exact response: CardPanelIdentity decodes them
  // (HobbyIQ/CompIQCardGrades.swift) and PortfolioHoldingDetailSheet hands
  // `displayName` down to CurrentlyListingSection, which otherwise joins a
  // holding's year in front of a setName that already leads with one. So
  // this case is the contract between the two repos: drop either field and
  // the iOS card title silently falls back to the composition that doubles.
  it("carries setName and displayName on the identity iOS decodes", async () => {
    const { valueIdentity } = await import("../src/services/compiq/oneValuationPath.service.js");
    const spy = vi.mocked(valueIdentity);
    spy.mockResolvedValueOnce({
      fairMarketValue: null,
      rungLabel: "no-basis",
      valueSource: "unavailable",
      reason: "no-comps",
      compsUsed: 0,
      confidence: 0,
      basis: "",
      requestedTier: "Raw",
      windowDays: null,
      trend: { direction: "flat", pctPerWeek: null },
      predictedPrice: null,
      weightedMedian: null,
      sales: [],
      ownerUserId: null,
      gradeCurve: [],
      totalSampleCount: 0,
      unified: null,
      fallback: null,
      poolMigrating: null,
      computedAt: "2026-09-06T00:00:00Z",
      identity: {
        slug: "hiq:baseball:2023:topps-heritage:74pb-1:base:no-auto",
        requestedId: "hiq:baseball:2023:topps-heritage:74pb-1:base:no-auto",
        pooledAs: null,
        pooledVia: null,
        sport: "baseball",
        year: 2023,
        setKey: "topps-heritage",
        // The STORED name, year-prefixed — the shape that makes the naive
        // `${year} ${set}` join render the year twice.
        setName: "2023 Topps Heritage",
        cardNumber: "74PB-1",
        parallel: "Base",
        parallelSlug: "base",
        isAuto: false,
        printRun: null,
        playerName: "Mike Trout",
        imageUrl: null,
      },
    } as unknown as Awaited<ReturnType<typeof valueIdentity>>);

    const res = await request(app)
      .get("/api/compiq/card-panel/hiq%3Abaseball%3A2023%3Atopps-heritage%3A74pb-1%3Abase%3Ano-auto")
      .set("x-session-id", "test-sess");

    expect(res.status).toBe(200);
    expect(res.body.identity).toBeTruthy();

    // `set` is UNCHANGED and still year-prefixed: server-side callers read
    // it as the stored value, and redefining it would rewrite stored data
    // as a side effect of a display fix.
    expect(res.body.identity.set).toBe("2023 Topps Heritage");

    // The two fields iOS reads.
    expect(res.body.identity.setName).toBe("Topps Heritage");
    expect(res.body.identity.displayName).toBe("2023 Topps Heritage Mike Trout #74PB-1");

    // MUTATION: red if the projection block ever ships the naive join.
    expect(res.body.identity.displayName).not.toBe(
      "2023 2023 Topps Heritage Mike Trout #74PB-1",
    );
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

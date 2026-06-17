/**
 * CF-REPRICE-PINNED-AUTHORITATIVE (2026-06-17): pinned-authoritative flag
 * coverage.
 *
 * The bug the flag closes: when a portfolio holding has a resolved
 * cardsightCardId but sparse identity fields (cardYear/product/parallel/
 * grade undefined), autoPriceHolding's call to computeEstimate composed
 * cardTitle = "<playerName>" (just the real name). The meaningful-query
 * gate at fetchComps then fired (player name didn't start with the pinned
 * UUID) and the call fell through to findCompsRouted → name search →
 * top catalog hit. For "Mike Trout" with no year, that resolved to a 2026
 * Bowman base with $1.90 median raw price instead of the stored 2011
 * Topps Update RC with $310 median.
 *
 * The fix: an optional `pinnedAuthoritative` flag in CompIQEstimateRequest
 * (default false) threaded via queryContext into fetchComps. When set true
 * with a pinned cardsightCardId, the meaningful-query check is bypassed
 * and the pinned-id branch fires regardless of cardTitle composition.
 *
 * /search, /price, /price-by-id remain unchanged (flag absent → default-
 * off → existing gate behaviour preserved). Test 2 specifically guards
 * the override-still-works invariant for those routes.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.mock("../src/services/compiq/cardsight.client.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getPricing: vi.fn(),
  };
});

vi.mock("../src/services/compiq/cardsight.router.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    findCompsRouted: vi.fn(),
    getCardSalesRouted: vi.fn(),
    searchCardsRouted: vi.fn(),
  };
});

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import { testCallContext } from "./_helpers/testCallContext.js";
import * as cardSight from "../src/services/compiq/cardsight.client.js";
import * as cardsightRouter from "../src/services/compiq/cardsight.router.js";

describe("computeEstimate — pinnedAuthoritative flag (CF-REPRICE-PINNED-AUTHORITATIVE)", () => {
  // Match the real Drew holding case: 2011 Topps Update Mike Trout RC base PSA-cohort
  const TROUT_2011_ID = "fda530ab-e925-460e-ab88-63199ef975e9";

  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
    process.env.CARDSIGHT_API_KEY = "test-cardsight-key";
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeTroutPricingResponse() {
    const today = new Date();
    const isoDaysAgo = (n: number) =>
      new Date(today.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
    // 12 raw records around the real ~$310 median observed in production
    const records = Array.from({ length: 12 }, (_, i) => ({
      title: "2011 Topps Update Series - Mike Trout #US175 (RC)",
      price: 280 + i * 10,
      date: isoDaysAgo(i % 5),
      source: "ebay" as const,
      url: null,
    }));
    return {
      card: {
        id: TROUT_2011_ID,
        card_id: TROUT_2011_ID,
        name: "Mike Trout",
        number: "US175",
        releaseName: "Topps Update",
        setName: "Topps Update",
        year: 2011,
        player: "Mike Trout",
        set: { name: "Base Set", release: "Topps Update", year: "2011" },
      },
      raw: { count: records.length, records },
      graded: [],
      meta: { total_records: records.length, last_sale_date: records[0].date },
    };
  }

  // ── Test 1 ────────────────────────────────────────────────────────────────
  // Reprice case: playerName="Mike Trout" + cardsightCardId set + flag=TRUE.
  // Without the flag, hasMeaningfulQuery=true ("Mike Trout" doesn't start
  // with UUID) → falls through to findCompsRouted. With flag=true, pinned
  // branch must fire.
  it("pinnedAuthoritative=true: REAL playerName + pinned UUID → pinned branch fires", async () => {
    (cardSight.getPricing as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeTroutPricingResponse(),
    );

    const result = (await computeEstimate(
      {
        playerName: "Mike Trout",
        cardsightCardId: TROUT_2011_ID,
        pinnedAuthoritative: true,
      } as any,
      testCallContext,
    )) as Record<string, unknown>;

    // Pinned branch took the call.
    expect(cardSight.getPricing).toHaveBeenCalledWith(TROUT_2011_ID);
    // Routed (name-search) path NOT taken.
    expect(cardsightRouter.findCompsRouted).not.toHaveBeenCalled();
    expect(cardsightRouter.searchCardsRouted).not.toHaveBeenCalled();

    // Real-name preservation guard: playerName stays "Mike Trout" all the
    // way through. The flag does NOT overload playerName with the UUID
    // (the /price-by-id pattern is intentionally NOT used here).
    expect((result as any).cardIdentity?.player ?? null).toBe("Mike Trout");

    // Sanity: comps came through.
    expect((result as any).compsUsed).toBeGreaterThan(0);
  });

  // ── Test 2 ────────────────────────────────────────────────────────────────
  // /search & /price safeguard: flag UNSET. A free-text query meaningfully
  // different from the pinned id MUST still fall through to findCompsRouted
  // (existing override semantics). This is the load-bearing invariant the
  // CF requires: "Other callers (/search, /price, /price-by-id) pass
  // nothing → flag off → unchanged."
  it("pinnedAuthoritative absent: free-text query differing from pinned id still overrides", async () => {
    const today = new Date();
    const isoDaysAgo = (n: number) =>
      new Date(today.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
    const sales = Array.from({ length: 12 }, (_, i) => ({
      price: 40 + i,
      date: isoDaysAgo(i % 5),
      grade: "Raw" as const,
      source: "cardsight" as const,
      sale_type: null,
      title: "2024 Topps Chrome Update Baseball Paul Skenes #USC150",
      url: null,
    }));
    (cardsightRouter.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "different-card-id",
        title: "2024 Topps Chrome Update Baseball Paul Skenes #USC150",
        player: "Paul Skenes",
        set: "2024 Topps Chrome Update",
        year: 2024,
        number: "USC150",
        variant: "Base",
      },
      sales,
      variantWarning: [],
      aiCategory: null,
    });

    await computeEstimate(
      {
        playerName: "2024 Topps Chrome Paul Skenes",
        cardsightCardId: TROUT_2011_ID,
        // pinnedAuthoritative is NOT set — default-off path
      } as any,
      testCallContext,
    );

    // Free-text override semantics preserved: pinned branch NOT taken.
    expect(cardSight.getPricing).not.toHaveBeenCalled();
    expect(cardsightRouter.findCompsRouted).toHaveBeenCalled();
  });

  it("pinnedAuthoritative=false (explicit): identical to absent — free-text query still overrides", async () => {
    const today = new Date();
    const isoDaysAgo = (n: number) =>
      new Date(today.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
    const sales = Array.from({ length: 8 }, (_, i) => ({
      price: 30 + i,
      date: isoDaysAgo(i),
      grade: "Raw" as const,
      source: "cardsight" as const,
      sale_type: null,
      title: "2024 Topps Chrome Paul Skenes",
      url: null,
    }));
    (cardsightRouter.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "different-card-id",
        title: "2024 Topps Chrome Paul Skenes",
        player: "Paul Skenes",
        set: "2024 Topps Chrome",
        year: 2024,
        number: null,
        variant: "Base",
      },
      sales,
      variantWarning: [],
      aiCategory: null,
    });

    await computeEstimate(
      {
        playerName: "2024 Topps Chrome Paul Skenes",
        cardsightCardId: TROUT_2011_ID,
        pinnedAuthoritative: false,
      } as any,
      testCallContext,
    );

    expect(cardSight.getPricing).not.toHaveBeenCalled();
    expect(cardsightRouter.findCompsRouted).toHaveBeenCalled();
  });

  // ── Test 3 ────────────────────────────────────────────────────────────────
  // Unpinned holding: no cardsightCardId. Flag has no effect; engine
  // resolves via findCompsRouted as today. This guards the "unpinned
  // holdings unaffected" invariant.
  it("no pinned cardsightCardId: flag has no effect → routed/identity path fires", async () => {
    const today = new Date();
    const isoDaysAgo = (n: number) =>
      new Date(today.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
    const sales = Array.from({ length: 12 }, (_, i) => ({
      price: 40 + i,
      date: isoDaysAgo(i % 5),
      grade: "Raw" as const,
      source: "cardsight" as const,
      sale_type: null,
      title: "2024 Topps Chrome Update Baseball Paul Skenes #USC150",
      url: null,
    }));
    (cardsightRouter.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "discovered-card-id",
        title: "2024 Topps Chrome Update Baseball Paul Skenes #USC150",
        player: "Paul Skenes",
        set: "2024 Topps Chrome Update",
        year: 2024,
        number: "USC150",
        variant: "Base",
      },
      sales,
      variantWarning: [],
      aiCategory: null,
    });

    await computeEstimate(
      {
        playerName: "Paul Skenes",
        cardYear: 2024,
        product: "Topps Chrome",
        // No cardsightCardId, no pinnedAuthoritative
      } as any,
      testCallContext,
    );

    // Routed path took the call; pinned branch impossible without an id.
    expect(cardsightRouter.findCompsRouted).toHaveBeenCalled();
    expect(cardSight.getPricing).not.toHaveBeenCalled();
  });

  it("pinnedAuthoritative=true but no cardsightCardId: still routed (flag alone doesn't conjure an id)", async () => {
    const today = new Date();
    const isoDaysAgo = (n: number) =>
      new Date(today.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
    const sales = Array.from({ length: 8 }, (_, i) => ({
      price: 30 + i,
      date: isoDaysAgo(i),
      grade: "Raw" as const,
      source: "cardsight" as const,
      sale_type: null,
      title: "Mike Trout",
      url: null,
    }));
    (cardsightRouter.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "some-resolved-id",
        title: "Mike Trout",
        player: "Mike Trout",
        set: "Bowman",
        year: 2026,
        number: null,
        variant: "Base",
      },
      sales,
      variantWarning: [],
      aiCategory: null,
    });

    await computeEstimate(
      {
        playerName: "Mike Trout",
        pinnedAuthoritative: true,
      } as any,
      testCallContext,
    );

    expect(cardsightRouter.findCompsRouted).toHaveBeenCalled();
    expect(cardSight.getPricing).not.toHaveBeenCalled();
  });

  // ── Test 4 ────────────────────────────────────────────────────────────────
  // Graceful degradation: pinned id is stale/unresolvable at Cardsight.
  // The pinned branch's notFound path returns empty comps + stub identity;
  // computeEstimate's downstream "no-recent-comps" / thin-card guards
  // surface the holding as unpriced rather than crashing or silently
  // pricing off the wrong card.
  it("stale/unresolvable pinned id: pinned branch returns empty comps; no crash, no wrong-card fallback", async () => {
    (cardSight.getPricing as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      notFound: true,
      raw: { count: 0, records: [] },
      graded: [],
      meta: { total_records: 0, last_sale_date: null },
    });

    const result = (await computeEstimate(
      {
        playerName: "Mike Trout",
        cardsightCardId: TROUT_2011_ID,
        pinnedAuthoritative: true,
      } as any,
      testCallContext,
    )) as Record<string, unknown>;

    // Pinned branch was attempted (we tried the stored id).
    expect(cardSight.getPricing).toHaveBeenCalledWith(TROUT_2011_ID);
    // Critically: did NOT fall back to free-text name search after the
    // pinned id returned notFound. Falling back would mis-price as a 2026
    // Bowman Trout (the bug this CF closes).
    expect(cardsightRouter.findCompsRouted).not.toHaveBeenCalled();
    expect(cardsightRouter.searchCardsRouted).not.toHaveBeenCalled();

    // compsUsed must be 0 — no comps found, no wrong-card fallback.
    expect((result as any).compsUsed ?? 0).toBe(0);
  });
});

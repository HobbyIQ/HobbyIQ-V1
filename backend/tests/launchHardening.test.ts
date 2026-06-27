// CF-LAUNCH-HARDENING (2026-06-02) — pre-modern, catalog-miss, approximate
// flag, outOfScopeReason. Locks the new response-contract states iOS will
// render against post-launch.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { testCallContext } from "./_helpers/testCallContext.js";

// CF-CARDSIGHT-REMOVAL (Wave 3): stub the trendIQ L3 forward-projection seam so
// computeEstimate doesn't make an un-mocked ~5s live fetchCompsByPlayer HTTP call
// and exceed the 5000ms vitest timeout. Empty comps keeps trendIQ "insufficient"
// (identical to the live fallback), leaving all assertions unaffected.
vi.mock("../src/services/compiq/compsByPlayer.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    fetchCompsByPlayer: vi.fn(
      async (input: { playerName: string; product: string; cardYear?: number }) => ({
        player: input.playerName,
        product: input.product,
        ...(input.cardYear !== undefined ? { cardYear: input.cardYear } : {}),
        cardIds: [],
        comps: [],
        cached: false,
        warnings: [],
      }),
    ),
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
import * as cardHedge from "../src/services/compiq/cardsight.router.js";

describe("CF-LAUNCH-HARDENING — pre-modern out-of-scope guard", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });
  beforeEach(() => vi.clearAllMocks());

  it("short-circuits with source=out-of-scope when cardYear < 1980", async () => {
    // Mock would never be reached on the pre-modern path; included for
    // defense — if the short-circuit ever regresses, the mock returns a
    // 1969 baseball card so the test fails LOUDLY on a downstream price.
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: { card_id: "should-not-fetch", title: "Should never reach", player: "Bobby Cox", set: "Topps", year: "1969", number: "1", variant: null },
      sales: [],
      variantWarning: [],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate(
      {
        playerName: "Bobby Cox",
        cardYear: 1969,
        product: "Topps",
      } as any,
      testCallContext,
    )) as Record<string, unknown>;

    expect(result.source).toBe("out-of-scope");
    expect(result.outOfScopeReason).toBe("pre-modern");
    expect(result.fairMarketValue).toBeNull();
    expect(result.predictedPrice).toBeNull();
    expect(typeof result.outOfScopeNote).toBe("string");
    expect(result.outOfScopeNote).toContain("Pre-1980");
    // Defense — confirm Cardsight was NEVER called (short-circuit fires BEFORE
    // fetchComps). The mock would have logged a call count > 0 if reached.
    expect(cardHedge.findCompsRouted).not.toHaveBeenCalled();
  });

  it("allows 1980-and-after through (boundary check)", async () => {
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: { card_id: "card-1980", title: "1980 Topps Tester", player: "Test Player", set: "Topps", year: "1980", number: "1", variant: null },
      sales: [],
      variantWarning: [],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate(
      {
        playerName: "Test Player",
        cardYear: 1980,
        product: "Topps",
      } as any,
      testCallContext,
    )) as Record<string, unknown>;

    // 1980 is the threshold itself; cards FROM 1980 should NOT be out-of-scope.
    expect(result.source).not.toBe("out-of-scope");
  });

  it("ignores missing cardYear (no guard triggered)", async () => {
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: { card_id: "card-no-year", title: "No year specified", player: "Test", set: "Topps", year: null, number: "1", variant: null },
      sales: [],
      variantWarning: [],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate(
      { playerName: "Test Player" } as any,
      testCallContext,
    )) as Record<string, unknown>;

    expect(result.source).not.toBe("out-of-scope");
  });
});

describe("CF-LAUNCH-HARDENING — catalog-miss source split", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });
  beforeEach(() => vi.clearAllMocks());

  it("emits source=catalog-miss when Cardsight returns 0 candidates AND 0 comps", async () => {
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: null,            // <-- catalog miss: no identity resolved
      sales: [],             // <-- AND no comps fell out from secondary paths
      variantWarning: [],
      aiCategory: null,
    });

    const result = (await computeEstimate(
      {
        playerName: "Nonexistent Player",
        cardYear: 2024,
        product: "Bowman Chrome",
      } as any,
      testCallContext,
    )) as Record<string, unknown>;

    expect(result.source).toBe("catalog-miss");
    expect(result.fairMarketValue).toBeNull();
    expect(result.predictedPrice).toBeNull();
    expect(typeof result.verdict).toBe("string");
    expect((result.verdict as string).toLowerCase()).toContain("catalog");
  });

  it("does NOT fire catalog-miss on the pinned cardsightCardId path", async () => {
    // Pinned path: even if comps are 0, this is no-recent-comps, not catalog-miss.
    // The card_id was authoritatively resolved upstream.
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: null,
      sales: [],
      variantWarning: [],
      aiCategory: null,
    });

    const result = (await computeEstimate(
      {
        playerName: "Test",
        cardYear: 2024,
        product: "Bowman Chrome",
        cardsightCardId: "test-card-uuid",
      } as any,
      testCallContext,
    )) as Record<string, unknown>;

    expect(result.source).not.toBe("catalog-miss");
  });
});

describe("CF-LAUNCH-HARDENING — unsupported_sport carries outOfScopeReason", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });
  beforeEach(() => vi.clearAllMocks());

  it("non-baseball card carries outOfScopeReason='unsupported-sport' (NEW iOS taxonomy field)", async () => {
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "jordan-bball",
        title: "1986 Fleer Michael Jordan PSA 8",
        player: "Michael Jordan",
        set: "Fleer",
        year: "1986",
        number: "57",
        variant: null,
      },
      sales: [],
      variantWarning: [],
      aiCategory: "Basketball",
    });

    const result = (await computeEstimate(
      {
        playerName: "Michael Jordan",
        cardYear: 1986,
        product: "Fleer",
      } as any,
      testCallContext,
    )) as Record<string, unknown>;

    // Boundary: 1986 is in-scope era (pre-modern guard does NOT fire), so we
    // proceed to fetchComps and hit the sport-scope guard. Both the legacy
    // source string AND the new taxonomy field must be present.
    expect(result.source).toBe("unsupported_sport");
    expect(result.outOfScopeReason).toBe("unsupported-sport");
    expect(typeof result.unsupportedSportReason).toBe("string");
    expect(result.detectedSport).toBe("Basketball");
  });
});

describe("CF-LAUNCH-HARDENING — errorHandler 5xx generic / 4xx pass-through", () => {
  it("5xx error returns generic 'Internal Server Error', NOT the internal err.message", async () => {
    const { errorHandler } = await import(
      "../src/middleware/errorHandler.js"
    );
    let captured: { status?: number; json?: any } = {};
    const fakeRes = {
      status: (n: number) => {
        captured.status = n;
        return { json: (body: any) => (captured.json = body) };
      },
    } as any;
    errorHandler(
      new Error("ECONNREFUSED 127.0.0.1:6379 (would leak internal infra)"),
      {} as any,
      fakeRes,
      () => {},
    );
    expect(captured.status).toBe(500);
    expect(captured.json).toEqual({ error: "Internal Server Error" });
    // Defensive: ensure internal infra strings do NOT leak.
    expect(JSON.stringify(captured.json)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(captured.json)).not.toContain("127.0.0.1");
  });

  it("4xx error passes through the message (validation copy is user-facing)", async () => {
    const { errorHandler } = await import(
      "../src/middleware/errorHandler.js"
    );
    let captured: { status?: number; json?: any } = {};
    const fakeRes = {
      status: (n: number) => {
        captured.status = n;
        return { json: (body: any) => (captured.json = body) };
      },
    } as any;
    const err: any = new Error("Missing 'query' field");
    err.status = 400;
    errorHandler(err, {} as any, fakeRes, () => {});
    expect(captured.status).toBe(400);
    expect(captured.json).toEqual({ error: "Missing 'query' field" });
  });

  it("err with no status defaults to 500 + generic message", async () => {
    const { errorHandler } = await import(
      "../src/middleware/errorHandler.js"
    );
    let captured: { status?: number; json?: any } = {};
    const fakeRes = {
      status: (n: number) => {
        captured.status = n;
        return { json: (body: any) => (captured.json = body) };
      },
    } as any;
    errorHandler(new Error("internal stack trace yikes"), {} as any, fakeRes, () => {});
    expect(captured.status).toBe(500);
    expect(captured.json.error).toBe("Internal Server Error");
  });

  it("err with no message + 4xx falls back to 'Bad Request' (no undefined)", async () => {
    const { errorHandler } = await import(
      "../src/middleware/errorHandler.js"
    );
    let captured: { status?: number; json?: any } = {};
    const fakeRes = {
      status: (n: number) => {
        captured.status = n;
        return { json: (body: any) => (captured.json = body) };
      },
    } as any;
    errorHandler({ status: 403 }, {} as any, fakeRes, () => {});
    expect(captured.status).toBe(403);
    expect(captured.json.error).toBe("Bad Request");
  });
});

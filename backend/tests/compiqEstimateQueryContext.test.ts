/**
 * Phase 2 — verifies computeEstimate builds queryContext from body fields and
 * threads it through to findCompsRouted, with a defensive parseCardQuery
 * fallback for /price-by-id requests whose body.playerName is an iOS
 * displayLabel (raw free-text) rather than a structured field.
 *
 * Coverage targets (docs/phase0/phase2_design.md §6):
 *  - queryContext threading: structured body fields reach findCompsRouted.opts
 *  - parseCardQuery fallback: when body has only a free-text playerName
 *    containing year+set, queryContext gets populated cardYear/product
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Mock findCompsRouted so we can capture opts directly. The pinned-card test
// mocks one layer deeper (cardhedge.client) and exercises the legacy path
// under CARDSIGHT_MODE=off; this test mocks the router itself to capture
// opts.queryContext regardless of mode.
vi.mock("../src/services/compiq/cardsight.router.js", () => ({
  findCompsRouted: vi.fn(),
  searchCardsRouted: vi.fn().mockResolvedValue([]),
  getCardSalesRouted: vi.fn().mockResolvedValue([]),
}));

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import { testCallContext } from "./_helpers/testCallContext.js";
import * as router from "../src/services/compiq/cardsight.router.js";

const mockFindCompsRouted = router.findCompsRouted as unknown as ReturnType<typeof vi.fn>;

function emptyRouted() {
  // Returning a card with empty sales triggers the "0 comps" branch in
  // fetchComps — sufficient for the test, since the assertions target the
  // opts.queryContext that findCompsRouted RECEIVED, not what the response
  // produced downstream.
  return {
    card: { card_id: "test-card-id", title: null, player: null, set: null, year: null, number: null, variant: null },
    sales: [],
    variantWarning: [],
    aiCategory: null,
  };
}

describe("computeEstimate — Phase 2 queryContext plumbing", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindCompsRouted.mockResolvedValue(emptyRouted());
  });

  it("threads structured body fields into findCompsRouted.opts.queryContext", async () => {
    await computeEstimate({
      playerName: "Mike Trout",
      cardYear: 2011,
      product: "Topps Update",
      parallel: "Refractor",
      gradeCompany: "PSA",
      gradeValue: 10,
    } as any, testCallContext);

    expect(mockFindCompsRouted).toHaveBeenCalled();
    const [, opts] = mockFindCompsRouted.mock.calls[0];
    expect(opts.queryContext).toBeDefined();
    expect(opts.queryContext.playerName).toBe("Mike Trout");
    expect(opts.queryContext.cardYear).toBe(2011);
    expect(opts.queryContext.product).toBe("Topps Update");
    expect(opts.queryContext.parallel).toBe("Refractor");
    expect(opts.queryContext.gradeCompany).toBe("PSA");
    expect(opts.queryContext.gradeValue).toBe("10");
  });

  it("defensive parseCardQuery fallback populates queryContext when body has only free-text playerName", async () => {
    // Simulates /price-by-id's body shape: body.playerName is the iOS
    // displayLabel; no structured cardYear/product/parallel set.
    await computeEstimate({
      playerName: "2011 Topps Update Baseball Mike Trout US175 Base",
      cardsightCardId: "fake-pinned-id",
    } as any, testCallContext);

    expect(mockFindCompsRouted).toHaveBeenCalled();
    const [, opts] = mockFindCompsRouted.mock.calls[0];
    expect(opts.queryContext).toBeDefined();
    // parsed.playerName should win over the noisy body.playerName.
    expect(opts.queryContext.playerName).toBe("Mike Trout");
    expect(opts.queryContext.cardYear).toBe(2011);
    expect(opts.queryContext.product).toBe("Topps Update");
  });

  it("structured body fields take precedence over parseCardQuery fallback (parse doesn't fire when year+product present)", async () => {
    await computeEstimate({
      playerName: "Mike Trout",
      cardYear: 2011,
      product: "Topps Update",
    } as any, testCallContext);

    expect(mockFindCompsRouted).toHaveBeenCalled();
    const [, opts] = mockFindCompsRouted.mock.calls[0];
    // Should use the structured body fields directly; parser fallback skipped.
    expect(opts.queryContext.playerName).toBe("Mike Trout");
    expect(opts.queryContext.cardYear).toBe(2011);
    expect(opts.queryContext.product).toBe("Topps Update");
  });

  it("queryContext is passed even when /price-by-id arrives without structured fields (Bonemer iOS displayLabel)", async () => {
    await computeEstimate({
      playerName: "2024 Bowman Draft Chrome Baseball Caleb Bonemer CPA-CBO Base Auto",
      cardsightCardId: "fake-pinned-id-bonemer",
    } as any, testCallContext);

    expect(mockFindCompsRouted).toHaveBeenCalled();
    const [, opts] = mockFindCompsRouted.mock.calls[0];
    expect(opts.queryContext.playerName).toBe("Caleb Bonemer");
    expect(opts.queryContext.cardYear).toBe(2024);
    expect(opts.queryContext.product).toBe("Bowman Draft Chrome");
  });

  // Phase 2 v2 defect #11 — cardNumber threading

  it("defect #11: queryContext.cardNumber populated from defensive parseCardQuery of iOS displayLabel", async () => {
    await computeEstimate({
      playerName: "2011 Topps Update Baseball Mike Trout US175 Base",
      cardsightCardId: "fake-pinned-id-trout",
    } as any, testCallContext);

    const [, opts] = mockFindCompsRouted.mock.calls[0];
    expect(opts.queryContext.cardNumber).toBe("US175");
  });

  it("defect #11: queryContext.cardNumber populated from body.cardNumber when structured (e.g. /price via requestFromParsed)", async () => {
    await computeEstimate({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "Bowman Draft Chrome",
      cardNumber: "CPA-CBO",
    } as any, testCallContext);

    const [, opts] = mockFindCompsRouted.mock.calls[0];
    expect(opts.queryContext.cardNumber).toBe("CPA-CBO");
  });

  it("defect #11: queryContext.cardNumber is undefined when neither body nor parse produced one (warming-compatible cache key)", async () => {
    await computeEstimate({
      playerName: "Mike Trout",
      cardYear: 2011,
      product: "Topps Update",
    } as any, testCallContext);

    const [, opts] = mockFindCompsRouted.mock.calls[0];
    expect(opts.queryContext.cardNumber).toBeUndefined();
  });
});

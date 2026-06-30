// CF-CH-DELTA-POLL-HOLDINGS-SUBSCRIBE (2026-06-30) — pins the holding
// → subscription extraction + the addHolding/updateHolding wire-in.
//
// THIS FILE PINS:
//   1. gradeStringFromHolding mapping (PSA 10, BGS 9.5, Raw fallback)
//   2. subscriptionItemFromHolding requires cardsightCardId + buildable grade
//   3. external_id format: userId:holdingId
//   4. holdingSubscriptionChanged only fires on (cardId, grade) deltas
//   5. batchSubscribeHoldings filters invalid + returns counts
//   6. subscribeHoldingToDeltaPoll is fire-and-forget (never throws)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const fetchMock = vi.fn();

vi.mock("../src/services/shared/cache.service.js", () => ({
  cacheWrap: (_key: string, fn: () => Promise<unknown>) => fn(),
  cacheKey: (...parts: string[]) => parts.join(":"),
}));

beforeEach(() => {
  // @ts-expect-error – global fetch override
  globalThis.fetch = fetchMock;
  fetchMock.mockReset();
  process.env.CARD_HEDGE_API_KEY = "test-key";
  delete process.env.CARD_HEDGE_CLIENT_ID;
});
afterEach(() => {
  delete process.env.CARD_HEDGE_API_KEY;
  delete process.env.CARD_HEDGE_CLIENT_ID;
});

function h(overrides: Partial<PortfolioHolding> = {}): PortfolioHolding {
  return {
    id: "h-1",
    cardsightCardId: "card-1",
    gradingCompany: "PSA",
    gradeValue: 10,
    ...overrides,
  } as PortfolioHolding;
}

describe("CF-CH-DELTA-POLL-HOLDINGS-SUBSCRIBE — gradeStringFromHolding", () => {
  it("PSA 10 → 'PSA 10'", async () => {
    const { gradeStringFromHolding } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    expect(gradeStringFromHolding(h({ gradingCompany: "PSA", gradeValue: 10 }))).toBe("PSA 10");
  });

  it("BGS 9.5 → 'BGS 9.5'", async () => {
    const { gradeStringFromHolding } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    expect(gradeStringFromHolding(h({ gradingCompany: "BGS", gradeValue: 9.5 }))).toBe("BGS 9.5");
  });

  it("missing gradingCompany → 'Raw'", async () => {
    const { gradeStringFromHolding } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    expect(gradeStringFromHolding(h({ gradingCompany: undefined, gradeValue: undefined }))).toBe("Raw");
  });

  it("uppercases grading company", async () => {
    const { gradeStringFromHolding } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    expect(gradeStringFromHolding(h({ gradingCompany: "psa", gradeValue: 10 }))).toBe("PSA 10");
  });

  it("invalid grade value → null", async () => {
    const { gradeStringFromHolding } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    expect(gradeStringFromHolding(h({ gradingCompany: "PSA", gradeValue: 0 }))).toBeNull();
    expect(gradeStringFromHolding(h({ gradingCompany: "PSA", gradeValue: -1 }))).toBeNull();
  });
});

describe("CF-CH-DELTA-POLL-HOLDINGS-SUBSCRIBE — subscriptionItemFromHolding", () => {
  it("returns {cardId, grade, externalId} with userId:holdingId format", async () => {
    const { subscriptionItemFromHolding } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    const item = subscriptionItemFromHolding("user-42", h({ id: "hold-7", cardsightCardId: "abc" }));
    expect(item).toEqual({ cardId: "abc", grade: "PSA 10", externalId: "user-42:hold-7" });
  });

  it("missing cardsightCardId → null", async () => {
    const { subscriptionItemFromHolding } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    expect(subscriptionItemFromHolding("u1", h({ cardsightCardId: null }))).toBeNull();
    expect(subscriptionItemFromHolding("u1", h({ cardsightCardId: "" }))).toBeNull();
  });

  it("invalid grade → null", async () => {
    const { subscriptionItemFromHolding } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    expect(subscriptionItemFromHolding("u1", h({ gradingCompany: "PSA", gradeValue: 0 }))).toBeNull();
  });
});

describe("CF-CH-DELTA-POLL-HOLDINGS-SUBSCRIBE — holdingSubscriptionChanged", () => {
  it("no previous → true (always subscribe on first add)", async () => {
    const { holdingSubscriptionChanged } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    expect(holdingSubscriptionChanged(undefined, h())).toBe(true);
  });

  it("cardsightCardId changed → true", async () => {
    const { holdingSubscriptionChanged } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    const a = h({ cardsightCardId: "card-1" });
    const b = h({ cardsightCardId: "card-2" });
    expect(holdingSubscriptionChanged(a, b)).toBe(true);
  });

  it("grade changed (Raw → PSA 10) → true", async () => {
    const { holdingSubscriptionChanged } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    const a = h({ gradingCompany: undefined, gradeValue: undefined });  // Raw
    const b = h({ gradingCompany: "PSA", gradeValue: 10 });
    expect(holdingSubscriptionChanged(a, b)).toBe(true);
  });

  it("only quantity / notes changed → false (skip re-subscribe)", async () => {
    const { holdingSubscriptionChanged } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    const a = h();
    const b = { ...h(), quantity: 5, notes: "updated" } as PortfolioHolding;
    expect(holdingSubscriptionChanged(a, b)).toBe(false);
  });
});

describe("CF-CH-DELTA-POLL-HOLDINGS-SUBSCRIBE — subscribeHoldingToDeltaPoll", () => {
  it("dormant without CARD_HEDGE_CLIENT_ID (no HTTP call)", async () => {
    const { subscribeHoldingToDeltaPoll } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    await subscribeHoldingToDeltaPoll("user-1", h());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fires CH subscribe call when client_id is set", async () => {
    process.env.CARD_HEDGE_CLIENT_ID = "client-x";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [{ card_id: "card-1", grade: "PSA 10", status: "success" }], total_requested: 1, total_successful: 1 }),
    });
    const { subscribeHoldingToDeltaPoll } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    await subscribeHoldingToDeltaPoll("user-1", h({ id: "h-99", cardsightCardId: "card-1" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.client_id).toBe("client-x");
    expect(body.subscriptions).toEqual([{ card_id: "card-1", grade: "PSA 10", external_id: "user-1:h-99" }]);
  });

  it("missing identity → silent skip (no HTTP call, no throw)", async () => {
    process.env.CARD_HEDGE_CLIENT_ID = "client-x";
    const { subscribeHoldingToDeltaPoll } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    await subscribeHoldingToDeltaPoll("user-1", h({ cardsightCardId: null }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("CH throws → caller never sees the exception", async () => {
    process.env.CARD_HEDGE_CLIENT_ID = "client-x";
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const { subscribeHoldingToDeltaPoll } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    await expect(subscribeHoldingToDeltaPoll("user-1", h())).resolves.toBeUndefined();
  });
});

describe("CF-CH-DELTA-POLL-HOLDINGS-SUBSCRIBE — batchSubscribeHoldings", () => {
  it("filters invalid + returns submitted/subscribed counts", async () => {
    process.env.CARD_HEDGE_CLIENT_ID = "client-x";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [], total_requested: 2, total_successful: 2 }),
    });
    const { batchSubscribeHoldings } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    const items = [
      { userId: "u1", holding: h({ id: "h1", cardsightCardId: "c1" }) },
      { userId: "u1", holding: h({ id: "h2", cardsightCardId: null }) },  // invalid
      { userId: "u2", holding: h({ id: "h3", cardsightCardId: "c3" }) },
    ];
    const r = await batchSubscribeHoldings(items);
    expect(r.submitted).toBe(2);
    expect(r.subscribed).toBe(2);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.subscriptions).toHaveLength(2);
  });

  it("dormant (no client_id) → submitted = valid items, subscribed = 0", async () => {
    const { batchSubscribeHoldings } = await import("../src/services/portfolioiq/deltaPollSubscriptions.service.js");
    const r = await batchSubscribeHoldings([
      { userId: "u1", holding: h({ id: "h1" }) },
      { userId: "u1", holding: h({ id: "h2" }) },
    ]);
    expect(r.submitted).toBe(2);
    expect(r.subscribed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

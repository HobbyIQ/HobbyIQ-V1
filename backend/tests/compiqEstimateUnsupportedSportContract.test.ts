import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Post-CF-CARDHEDGE-HARD-CUTOVER: mocks target cardsight.router instead
// of the deleted cardhedge.client. The router's findCompsRouted return
// shape (RoutedResult) matches the prior cardhedge findCompsByQuery shape.
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
import * as cardHedge from "../src/services/compiq/cardsight.router.js";

describe("computeEstimate unsupported_sport contract", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("always emits predictedPriceRange key (null) on unsupported_sport responses", async () => {
    (cardHedge.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-1",
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

    const result = (await computeEstimate({
      playerName: "1986 Fleer Michael Jordan PSA 8",
    } as any, testCallContext)) as Record<string, unknown>;

    expect(result.source).toBe("unsupported_sport");
    expect(Object.prototype.hasOwnProperty.call(result, "predictedPrice")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result, "predictedPriceRange")).toBe(true);
    expect(result.predictedPriceRange).toBeNull();
  });
});

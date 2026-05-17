import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  getCardSales: vi.fn(),
  searchCards: vi.fn(),
  findCompsByQuery: vi.fn(),
}));

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import * as cardHedge from "../src/services/compiq/cardhedge.client.js";

describe("computeEstimate unsupported_sport contract", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("always emits predictedPriceRange key (null) on unsupported_sport responses", async () => {
    (cardHedge.findCompsByQuery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
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
    } as any)) as Record<string, unknown>;

    expect(result.source).toBe("unsupported_sport");
    expect(Object.prototype.hasOwnProperty.call(result, "predictedPrice")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result, "predictedPriceRange")).toBe(true);
    expect(result.predictedPriceRange).toBeNull();
  });
});

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  getCardSales: vi.fn(),
  searchCards: vi.fn(),
  findCompsByQuery: vi.fn(),
}));

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import * as cardHedge from "../src/services/compiq/cardhedge.client.js";

describe("Wyatt Langford integration - Mechanism 1", () => {
  it("returns non-null predictedPrice for Blue /150 auto input when anchor comps exist", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";

    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

    (cardHedge.findCompsByQuery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-wyatt-blue-auto-150",
        title: "2022 Bowman Chrome Wyatt Langford Blue Refractor Auto /150",
        player: "Wyatt Langford",
        set: "Bowman Chrome",
        year: 2022,
        number: "CPA-WL",
        variant: "Blue Refractor Auto /150",
      },
      sales: [
        { price: 180, date: isoDaysAgo(8), title: "2022 Bowman Draft CDA-WL Wyatt Langford Refractor Auto /499" },
        { price: 190, date: isoDaysAgo(11), title: "2022 Bowman Draft CDA-WL Wyatt Langford Refractor Auto /499" },
        { price: 200, date: isoDaysAgo(16), title: "2022 Bowman Draft CDA-WL Wyatt Langford Refractor Auto /499" },
        { price: 320, date: isoDaysAgo(20), title: "2022 Bowman Draft CDA-WL Wyatt Langford Purple Refractor Auto /250" },
        { price: 1500, date: isoDaysAgo(24), title: "2022 Bowman Draft CDA-WL Wyatt Langford Gold Refractor Auto /50" },
      ],
      variantWarning: ["auto_mismatch"],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate({
      playerName: "Wyatt Langford",
      cardYear: 2022,
      product: "Bowman Chrome",
      parallel: "Blue Refractor /150 Auto",
      isAuto: true,
    } as any)) as Record<string, any>;

    expect(result.marketValue).toBeNull();
    expect(result.predictedPrice).toBe(703);
    expect(result.predictedPriceRange).toEqual({ low: 570, high: 836 });
    expect(result.predictedPriceAttribution?.mechanism).toBe("multiplier-anchored");
    expect(result.predictedPriceAttribution?.failureReason).toBeUndefined();
    expect(result.predictedPriceAttribution?.anchorParallel).toBe("Refractor");
    expect(result.predictedPriceAttribution?.anchorProduct).toBe("Bowman Draft");
    expect(result.predictedPriceAttribution?.multiplierRange).toEqual({ low: 3, high: 4.4 });
  });
});

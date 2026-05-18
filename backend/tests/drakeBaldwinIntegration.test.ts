import { describe, it, expect, vi } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  getCardSales: vi.fn(),
  searchCards: vi.fn(),
  findCompsByQuery: vi.fn(),
}));

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import * as cardHedge from "../src/services/compiq/cardhedge.client.js";

describe("Drake Baldwin integration — Mechanism 1", () => {
  it("returns null marketValue and non-null predictedPrice from multiplier-anchored attribution", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";

    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

    (cardHedge.findCompsByQuery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: "card-drake-blue-auto-150",
        title: "2022 Bowman Chrome Drake Baldwin Blue Refractor Auto /150",
        player: "Drake Baldwin",
        set: "Bowman Chrome",
        year: 2022,
        number: "CPA-DBN",
        variant: "Blue Refractor Auto /150",
      },
      sales: [
        { price: 145, date: isoDaysAgo(8), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
        { price: 150, date: isoDaysAgo(11), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
        { price: 155, date: isoDaysAgo(16), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
        { price: 250, date: isoDaysAgo(20), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Purple Refractor Auto /250" },
        { price: 1100, date: isoDaysAgo(24), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Gold Refractor Auto /50" },
      ],
      variantWarning: ["auto_mismatch"],
      aiCategory: "Baseball",
    });

    const result = (await computeEstimate({
      playerName: "Drake Baldwin",
      cardYear: 2022,
      product: "Bowman Chrome",
      parallel: "Blue Refractor",
      isAuto: true,
    } as any)) as Record<string, any>;

    expect(result.marketValue).toBeNull();
    expect(typeof result.predictedPrice).toBe("number");
    expect(result.predictedPrice).toBeGreaterThanOrEqual(300);
    expect(result.predictedPrice).toBeLessThanOrEqual(700);
    expect(result.predictedPriceAttribution?.mechanism).toBe("multiplier-anchored");
    expect(typeof result.predictedPriceAttribution?.anchorParallel).toBe("string");
  });
});
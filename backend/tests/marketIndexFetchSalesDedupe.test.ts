// CF-DEDUPE-SOLD-COMPS-EVERY-READER (2026-09-20). `fetchSales` feeds both
// basket selection (selectBasket, via eligibilitySales) and each member's
// `trendValue` fit — the two places the market index is most exposed to a
// CardHedge dual-id twin double-weighting a card's value, the same failure
// mode unifiedPricing.service.ts fixed for the FMV path. This pins that
// `fetchSales` now dedupes PER cardId (never across cards) using the same
// gradeKey|price|60-minute rule, and that two different cards sharing a
// price and moment are never merged into one.
import { describe, it, expect } from "vitest";
import { fetchSales, groupByCard } from "../src/services/insights/marketIndex.service.js";

interface FakeRow {
  cardId: string;
  price: number;
  soldAt: string;
  gradeCompany?: string | null;
  gradeValue?: number | null;
}

function fakeContainer(rows: FakeRow[]) {
  let done = false;
  return {
    items: {
      query: () => ({
        hasMoreResults: () => !done,
        fetchNext: async () => {
          done = true;
          return { resources: rows };
        },
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("fetchSales — dedupes the CardHedge dual-id twin per card", () => {
  it("collapses a twin pair on ONE card; a genuinely distinct sale on the SAME card survives", async () => {
    const container = fakeContainer([
      { cardId: "card-a", price: 100, soldAt: "2026-07-14T23:35:00Z" },
      { cardId: "card-a", price: 100, soldAt: "2026-07-14T23:35:26Z" }, // twin of above
      { cardId: "card-a", price: 150, soldAt: "2026-07-15T10:00:00Z" }, // distinct sale
    ]);
    const rows = await fetchSales(container, "baseball", "2026-07-01", "2026-08-01");
    expect(rows).toHaveLength(2);
    const prices = rows.map((r) => r.price).sort((a, b) => a - b);
    expect(prices).toEqual([100, 150]);
  });

  it("never collapses two DIFFERENT cards that happen to share a price and moment", async () => {
    const sameMoment = "2026-07-14T23:35:00Z";
    const container = fakeContainer([
      { cardId: "card-a", price: 100, soldAt: sameMoment },
      { cardId: "card-b", price: 100, soldAt: sameMoment },
    ]);
    const rows = await fetchSales(container, "baseball", "2026-07-01", "2026-08-01");
    // Both must survive — the dedupe key never crosses cardId.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.cardId).sort()).toEqual(["card-a", "card-b"]);
  });

  it("never collapses two DIFFERENT grades of the same card sharing a price and moment", async () => {
    const sameMoment = "2026-07-14T23:35:00Z";
    const container = fakeContainer([
      { cardId: "card-a", price: 100, soldAt: sameMoment, gradeCompany: null, gradeValue: null },
      { cardId: "card-a", price: 100, soldAt: sameMoment, gradeCompany: "PSA", gradeValue: 10 },
    ]);
    const rows = await fetchSales(container, "baseball", "2026-07-01", "2026-08-01");
    expect(rows).toHaveLength(2);
  });

  it("counts change only by the twin: groupByCard's eligibility count reflects the dedupe", async () => {
    const container = fakeContainer([
      { cardId: "card-a", price: 100, soldAt: "2026-07-01T00:00:00Z" },
      { cardId: "card-a", price: 100, soldAt: "2026-07-01T00:03:00Z" }, // twin
      { cardId: "card-a", price: 110, soldAt: "2026-07-02T00:00:00Z" },
      { cardId: "card-a", price: 120, soldAt: "2026-07-03T00:00:00Z" },
    ]);
    const rows = await fetchSales(container, "baseball", "2026-07-01", "2026-08-01");
    const grouped = groupByCard(rows);
    expect(grouped.get("card-a")?.sales).toBe(3); // not 4
  });
});

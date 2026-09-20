// CF-DEDUPE-SOLD-COMPS-EVERY-READER (2026-09-20). `fetchSales` feeds both
// basket selection (selectBasket, via eligibilitySales) and each member's
// `trendValue` fit — the two places the market index is most exposed to a
// CardHedge dual-id twin double-weighting a card's value, the same failure
// mode unifiedPricing.service.ts fixed for the FMV path. This pins that
// `fetchSales` now dedupes PER cardId (never across cards) using the same
// gradeKey|price|60-minute rule, and that two different cards sharing a
// price and moment are never merged into one.
//
// CF-VOLUME-READERS-NEED-DISTINCT-WRITERS (2026-09-20, review fix).
// `fetchSales` feeds `trendValue`/`eligibilitySales`, both volume-sensitive,
// so it dedupes with `onlyWhen: distinctWriterShape` — a pair collapses
// ONLY when the two rows are different writer shapes (the CardHedge
// dual-id bug's real signature), never on price+time alone. Every fixture
// below that is meant to collapse carries two DIFFERENT writer shapes; a
// same-shape pair is proven to survive.
import { describe, it, expect } from "vitest";
import { fetchSales, groupByCard } from "../src/services/insights/marketIndex.service.js";

interface FakeRow {
  cardId: string;
  price: number;
  soldAt: string;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  source?: string | null;
  sourceExternalId?: string | null;
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

describe("fetchSales — dedupes the CardHedge dual-id twin per card, only across distinct writer shapes", () => {
  it("collapses a genuine dual-id twin pair (bare + composite ch-daily) on ONE card; a distinct sale on the SAME card survives", async () => {
    const container = fakeContainer([
      { cardId: "card-a", price: 100, soldAt: "2026-07-14T23:35:00Z", source: "cardhedge", sourceExternalId: "ch-daily::abc111" },
      { cardId: "card-a", price: 100, soldAt: "2026-07-14T23:35:26Z", source: "cardhedge", sourceExternalId: "ch-daily::card-a::2026-07-14T23:35:00Z::10000" }, // twin, composite shape
      { cardId: "card-a", price: 150, soldAt: "2026-07-15T10:00:00Z", source: "cardhedge", sourceExternalId: "ch-daily::xyz999" }, // distinct sale
    ]);
    const rows = await fetchSales(container, "baseball", "2026-07-01", "2026-08-01");
    expect(rows).toHaveLength(2);
    const prices = rows.map((r) => r.price).sort((a, b) => a - b);
    expect(prices).toEqual([100, 150]);
  });

  it("KEEPS two SAME-shape sales of a common at the same price/moment (real volume, not the dual-id bug)", async () => {
    const sameMoment = "2026-07-14T23:35:00Z";
    const container = fakeContainer([
      { cardId: "card-a", price: 1.99, soldAt: sameMoment, source: "cardhedge", sourceExternalId: "ch-daily::tokenA" },
      { cardId: "card-a", price: 1.99, soldAt: sameMoment, source: "cardhedge", sourceExternalId: "ch-daily::tokenB" },
    ]);
    const rows = await fetchSales(container, "baseball", "2026-07-01", "2026-08-01");
    expect(rows).toHaveLength(2);
  });

  it("30 genuine same-shape sales of a common in one hour ALL survive on the index's fetch", async () => {
    const base = Date.parse("2026-07-14T10:00:00Z");
    const rowsIn: FakeRow[] = Array.from({ length: 30 }, (_, i) => ({
      cardId: "card-a", price: 1.99, soldAt: new Date(base + i * 60_000).toISOString(),
      source: "cardhedge", sourceExternalId: `ch-daily::token-${i}`,
    }));
    const container = fakeContainer(rowsIn);
    const rows = await fetchSales(container, "baseball", "2026-07-01", "2026-08-01");
    expect(rows).toHaveLength(30);
  });

  it("never collapses two DIFFERENT cards that happen to share a price and moment", async () => {
    const sameMoment = "2026-07-14T23:35:00Z";
    const container = fakeContainer([
      { cardId: "card-a", price: 100, soldAt: sameMoment, source: "cardhedge", sourceExternalId: "ch-daily::abc111" },
      { cardId: "card-b", price: 100, soldAt: sameMoment, source: "cardhedge", sourceExternalId: "ch-daily::card-b::2026-07-14T23:35:00Z::10000" },
    ]);
    const rows = await fetchSales(container, "baseball", "2026-07-01", "2026-08-01");
    // Both must survive — the dedupe key never crosses cardId, regardless
    // of writer shape.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.cardId).sort()).toEqual(["card-a", "card-b"]);
  });

  it("never collapses two DIFFERENT grades of the same card sharing a price and moment", async () => {
    const sameMoment = "2026-07-14T23:35:00Z";
    const container = fakeContainer([
      { cardId: "card-a", price: 100, soldAt: sameMoment, gradeCompany: null, gradeValue: null, source: "cardhedge", sourceExternalId: "ch-daily::abc111" },
      { cardId: "card-a", price: 100, soldAt: sameMoment, gradeCompany: "PSA", gradeValue: 10, source: "cardhedge", sourceExternalId: "ch-daily::card-a::2026-07-14T23:35:00Z::10000" },
    ]);
    const rows = await fetchSales(container, "baseball", "2026-07-01", "2026-08-01");
    expect(rows).toHaveLength(2);
  });

  it("counts change only by the twin: groupByCard's eligibility count reflects the dedupe", async () => {
    const container = fakeContainer([
      { cardId: "card-a", price: 100, soldAt: "2026-07-01T00:00:00Z", source: "cardhedge", sourceExternalId: "ch-daily::abc111" },
      { cardId: "card-a", price: 100, soldAt: "2026-07-01T00:03:00Z", source: "cardhedge", sourceExternalId: "ch-daily::card-a::2026-07-01T00:00:00Z::10000" }, // twin, composite shape
      { cardId: "card-a", price: 110, soldAt: "2026-07-02T00:00:00Z", source: "cardhedge", sourceExternalId: "ch-daily::def222" },
      { cardId: "card-a", price: 120, soldAt: "2026-07-03T00:00:00Z", source: "cardhedge", sourceExternalId: "ch-daily::ghi333" },
    ]);
    const rows = await fetchSales(container, "baseball", "2026-07-01", "2026-08-01");
    const grouped = groupByCard(rows);
    expect(grouped.get("card-a")?.sales).toBe(3); // not 4
  });
});

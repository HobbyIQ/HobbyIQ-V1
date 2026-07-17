// CF-LOCAL-COMP-FIRST (Drew, 2026-07-17). Integration-style tests for
// the query builder + orchestration layer of localCompStore. Cosmos
// is stubbed via _setContainerForTesting.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildQuery,
  lookupLocalComps,
  _setContainerForTesting,
} from "../src/services/portfolioiq/localCompStore.service.js";
import type { CHDailySaleRow } from "../src/types/chDailySales.types.js";

function makeRow(overrides: Partial<CHDailySaleRow> = {}): CHDailySaleRow {
  return {
    price_history_id: `phid-${Math.random().toString(36).slice(2, 8)}`,
    source: "ebay",
    description: "",
    price: 10,
    listing_url: "",
    image_url: "",
    pop: 0,
    sale_date: "2026-07-01T12:00:00Z",
    sale_type: "BIN",
    card_id: "card-1",
    card_description: "",
    number: "1",
    player: "Player",
    grade: "Raw",
    grader: "Raw",
    group: "Baseball",
    card_set: "Set",
    card_set_type: "Type",
    variant: "Base",
    year: 2025,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function makeContainerStub(rows: CHDailySaleRow[], ruPerPage = 2.5): any {
  return {
    items: {
      query: (_spec: any, _opts: any) => {
        let called = false;
        return {
          hasMoreResults: () => !called,
          fetchNext: async () => {
            called = true;
            return { resources: rows, requestCharge: ruPerPage };
          },
        };
      },
    },
  };
}

describe("buildQuery", () => {
  it("throws on empty key", () => {
    expect(() => buildQuery({})).toThrow(/at least one key field/);
  });

  it("returns single-partition read when cardId is set", () => {
    const q = buildQuery({ cardId: "card-42" });
    expect(q.partition).toBe("cardId");
    expect(q.query).toContain("c.card_id = @cardId");
    expect(q.parameters).toEqual([{ name: "@cardId", value: "card-42" }]);
  });

  it("returns cross-partition when structured key only", () => {
    const q = buildQuery({ year: 2025, cardSet: "2025 Topps Baseball", variant: "Base" });
    expect(q.partition).toBe("cross");
    expect(q.query).toContain("c.year = @year");
    expect(q.query).toContain("c.card_set = @cardSet");
    expect(q.query).toContain("c.variant = @variant");
    expect(q.parameters).toHaveLength(3);
  });

  it("includes c.player = @player clause when player is set (strong-triple lookup)", () => {
    const q = buildQuery({ player: "Eric Hartman", year: 2026, number: "CPA-EHA" });
    expect(q.partition).toBe("cross");
    expect(q.query).toContain("c.player = @player");
    expect(q.query).toContain("c.year = @year");
    expect(q.query).toContain("c.number = @number");
    expect(q.parameters).toEqual([
      { name: "@player", value: "Eric Hartman" },
      { name: "@year", value: 2026 },
      { name: "@number", value: "CPA-EHA" },
    ]);
  });

  it("allGrades drops grader/grade/variant filters but keeps SKU filters", () => {
    const q = buildQuery({
      year: 2025, cardSet: "2025 Topps Baseball", variant: "Base",
      number: "1", grade: "PSA 10", grader: "PSA", allGrades: true,
    });
    // WHERE clause parameters — grader/grade/variant should be absent.
    const paramNames = q.parameters.map((p) => p.name);
    expect(paramNames).not.toContain("@grader");
    expect(paramNames).not.toContain("@grade");
    expect(paramNames).not.toContain("@variant");
    expect(paramNames).toEqual(expect.arrayContaining(["@year", "@cardSet", "@number"]));
    // SELECT list still returns them — for premium computation.
    expect(q.query).toContain("c.grader");
    expect(q.query).toContain("c.grade");
    expect(q.query).toContain("c.variant");
  });

  it("parameterizes number when set", () => {
    const q = buildQuery({ cardSet: "Set", number: "BCP-102" });
    expect(q.parameters.find((p) => p.name === "@number")?.value).toBe("BCP-102");
  });
});

describe("lookupLocalComps orchestration", () => {
  afterEach(() => _setContainerForTesting(null));

  it("returns empty-but-valid result on 0 rows", async () => {
    _setContainerForTesting(makeContainerStub([]));
    const r = await lookupLocalComps({ cardId: "empty-card" });
    expect(r.totalSales).toBe(0);
    expect(r.windowSales).toBe(0);
    expect(r.recentSales).toEqual([]);
    expect(r.trend).toBeNull();
    expect(r.graderPremiums).toEqual({});
    expect(r.parallelPremiums).toEqual({});
    expect(r.diagnostics.partitionKey).toBe("cardId");
  });

  it("returns totalSales + windowSales when rows land", async () => {
    const now = new Date();
    const rows = [
      makeRow({ sale_date: new Date(now.getTime() - 10 * 86400000).toISOString(), price: 100 }),
      makeRow({ sale_date: new Date(now.getTime() - 30 * 86400000).toISOString(), price: 90 }),
      // outside window
      makeRow({ sale_date: new Date(now.getTime() - 200 * 86400000).toISOString(), price: 50 }),
    ];
    _setContainerForTesting(makeContainerStub(rows));
    const r = await lookupLocalComps({ cardId: "c" }, { trendWindowDays: 90 });
    expect(r.totalSales).toBe(3);
    expect(r.windowSales).toBe(2);
    expect(r.recentSales).toHaveLength(3);
  });

  it("sorts recentSales date-desc", async () => {
    const now = new Date();
    const rows = [
      makeRow({ sale_date: new Date(now.getTime() - 30 * 86400000).toISOString(), price: 5, price_history_id: "OLD" }),
      makeRow({ sale_date: new Date(now.getTime() - 1 * 86400000).toISOString(), price: 10, price_history_id: "NEW" }),
      makeRow({ sale_date: new Date(now.getTime() - 10 * 86400000).toISOString(), price: 7, price_history_id: "MID" }),
    ];
    _setContainerForTesting(makeContainerStub(rows));
    const r = await lookupLocalComps({ cardId: "c" });
    expect(r.recentSales.map((s) => s.priceHistoryId)).toEqual(["NEW", "MID", "OLD"]);
  });

  it("caps recentSales at recentSalesLimit", async () => {
    const now = new Date();
    const rows = Array.from({ length: 50 }, (_, i) =>
      makeRow({ sale_date: new Date(now.getTime() - i * 86400000).toISOString(), price: 10 + i }),
    );
    _setContainerForTesting(makeContainerStub(rows));
    const r = await lookupLocalComps({ cardId: "c" }, { recentSalesLimit: 5 });
    expect(r.recentSales).toHaveLength(5);
    expect(r.totalSales).toBe(50);
  });

  it("skips premium math when skipPremiums=true", async () => {
    const now = new Date();
    const rows: CHDailySaleRow[] = [];
    for (let i = 0; i < 5; i++) rows.push(makeRow({ price: 10, grader: "Raw", sale_date: new Date(now.getTime() - i * 86400000).toISOString() }));
    for (let i = 0; i < 5; i++) rows.push(makeRow({ price: 100, grader: "PSA", grade: "PSA 10", sale_date: new Date(now.getTime() - i * 86400000).toISOString() }));
    _setContainerForTesting(makeContainerStub(rows));
    const r = await lookupLocalComps({ cardId: "c" }, { skipPremiums: true });
    expect(r.graderPremiums).toEqual({});
    expect(r.parallelPremiums).toEqual({});
    expect(r.trend).not.toBeNull();
  });

  it("captures RU charge in diagnostics", async () => {
    _setContainerForTesting(makeContainerStub([makeRow()], 4.75));
    const r = await lookupLocalComps({ cardId: "c" });
    expect(r.diagnostics.ruCharge).toBe(4.75);
  });
});

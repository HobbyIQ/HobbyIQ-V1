// CF-EBAY-SOLD-COMPS-QUERY (2026-07-12) — matching + ranking + stats
// unit tests for the sold-comps query surface.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock the dependency BEFORE importing the SUT.
vi.mock("../src/services/portfolioiq/portfolioStore.service.js", () => ({
  listAllPortfolioUserIds: vi.fn(),
  readUserDoc: vi.fn(),
}));

import { querySoldComps } from "../src/services/portfolioiq/ebaySoldComps.service.js";
import * as store from "../src/services/portfolioiq/portfolioStore.service.js";

function makeSaleEntry(overrides: Record<string, any> = {}) {
  return {
    id: "l-1",
    userId: "user-1",
    holdingId: "h-1",
    playerName: "Mookie Betts",
    cardTitle: "2020 Panini Prizm Mookie Betts",
    quantitySold: 1,
    unitSalePrice: 250,
    grossProceeds: 250,
    fees: 0,
    tax: 0,
    shipping: 0,
    netProceeds: 225,
    costBasisSold: 100,
    realizedProfitLoss: 125,
    realizedProfitLossPct: 125,
    soldAt: "2026-06-01T00:00:00Z",
    source: "ebay",
    ebayOrderId: "o-1",
    ebayListingId: "L-1",
    ebayItemAspects: {
      Player: "Mookie Betts",
      Team: "Los Angeles Dodgers",
      Sport: "Baseball",
      Season: "2020",
      Set: "Panini Prizm",
      Manufacturer: "Panini",
      "Card Number": "275",
      "Parallel/Variety": "Silver",
      "Professional Grader": "Professional Sports Authenticator (PSA)",
      Grade: "10",
      Autographed: "No",
    },
    ebayImageUrl: "https://i.ebayimg.com/x.jpg",
    ebayCategoryPath: "Sports Mem|Baseball Cards",
    enrichedFromEbay: true,
    ...overrides,
  };
}

function mockDocs(...docs: Array<{ userId: string; ledger: any[] }>) {
  const uidToDoc = new Map(docs.map((d) => [d.userId, d]));
  vi.mocked(store.listAllPortfolioUserIds).mockResolvedValue(docs.map((d) => d.userId));
  vi.mocked(store.readUserDoc).mockImplementation(async (uid: string) => uidToDoc.get(uid) as any);
}

beforeEach(() => vi.mocked(store.listAllPortfolioUserIds).mockReset());
afterEach(() => vi.restoreAllMocks());

describe("querySoldComps — matching", () => {
  it("returns all ebay sales when no filters given", async () => {
    mockDocs({
      userId: "u-1",
      ledger: [makeSaleEntry(), makeSaleEntry({ id: "l-2", soldAt: "2026-05-01T00:00:00Z" })],
    });
    const r = await querySoldComps({});
    expect(r.count).toBe(2);
    expect(r.stats.medianPrice).toBe(250);
  });

  it("filters by year via aspects", async () => {
    mockDocs({
      userId: "u-1",
      ledger: [
        makeSaleEntry(),
        makeSaleEntry({
          id: "l-2",
          ebayItemAspects: { ...makeSaleEntry().ebayItemAspects, Season: "2019" },
        }),
      ],
    });
    const r = await querySoldComps({ year: 2020 });
    expect(r.count).toBe(1);
    expect(r.comps[0].soldAt).toBe("2026-06-01T00:00:00Z");
  });

  it("filters by set (case-insensitive substring)", async () => {
    mockDocs({
      userId: "u-1",
      ledger: [
        makeSaleEntry(),   // Panini Prizm
        makeSaleEntry({
          id: "l-2",
          ebayItemAspects: { ...makeSaleEntry().ebayItemAspects, Set: "Topps Chrome" },
        }),
      ],
    });
    const r = await querySoldComps({ set: "prizm" });
    expect(r.count).toBe(1);
  });

  it("filters by parallel", async () => {
    mockDocs({
      userId: "u-1",
      ledger: [
        makeSaleEntry(),   // Silver
        makeSaleEntry({
          id: "l-2",
          ebayItemAspects: { ...makeSaleEntry().ebayItemAspects, "Parallel/Variety": "Gold" },
        }),
      ],
    });
    const r = await querySoldComps({ parallel: "gold" });
    expect(r.count).toBe(1);
  });

  it("filters by grade with normalized combined form", async () => {
    mockDocs({
      userId: "u-1",
      ledger: [
        makeSaleEntry(),   // PSA 10
        makeSaleEntry({
          id: "l-2",
          ebayItemAspects: { ...makeSaleEntry().ebayItemAspects, Grade: "9" },
        }),
      ],
    });
    // Both "PSA 10" and "PSA10" should match the PSA 10 entry
    const r1 = await querySoldComps({ grade: "PSA 10" });
    expect(r1.count).toBe(1);
    const r2 = await querySoldComps({ grade: "PSA10" });
    expect(r2.count).toBe(1);
  });

  it("filters by isAuto true/false", async () => {
    mockDocs({
      userId: "u-1",
      ledger: [
        makeSaleEntry(),   // Autographed: No
        makeSaleEntry({
          id: "l-2",
          ebayItemAspects: { ...makeSaleEntry().ebayItemAspects, Autographed: "Yes" },
        }),
      ],
    });
    expect((await querySoldComps({ isAuto: true })).count).toBe(1);
    expect((await querySoldComps({ isAuto: false })).count).toBe(1);
  });

  it("excludes non-ebay entries and regrade actions", async () => {
    mockDocs({
      userId: "u-1",
      ledger: [
        makeSaleEntry(),
        makeSaleEntry({ id: "l-2", source: "manual" }),
        makeSaleEntry({ id: "l-3", action: "regrade" }),
        makeSaleEntry({ id: "l-4", unitSalePrice: 0 }),
      ],
    });
    const r = await querySoldComps({});
    expect(r.count).toBe(1);
  });
});

describe("querySoldComps — ranking + stats", () => {
  it("ranks perfect-match ahead of partial-match, then by recency", async () => {
    mockDocs({
      userId: "u-1",
      ledger: [
        // Old exact-match — high score, old
        makeSaleEntry({ id: "l-old-exact", soldAt: "2025-01-01T00:00:00Z", unitSalePrice: 300 }),
        // Recent partial (wrong set) — lower score, recent
        makeSaleEntry({
          id: "l-recent-partial",
          soldAt: "2026-07-01T00:00:00Z",
          unitSalePrice: 400,
          ebayItemAspects: { ...makeSaleEntry().ebayItemAspects, Set: "Bowman" },
        }),
      ],
    });
    const r = await querySoldComps({ year: 2020, set: "prizm" });
    expect(r.count).toBe(1);
    expect(r.comps[0].id ?? r.comps[0].soldAt).toBe("2025-01-01T00:00:00Z");
  });

  it("computes stats: min, max, median, mean", async () => {
    mockDocs({
      userId: "u-1",
      ledger: [
        makeSaleEntry({ id: "l-1", unitSalePrice: 100 }),
        makeSaleEntry({ id: "l-2", unitSalePrice: 200 }),
        makeSaleEntry({ id: "l-3", unitSalePrice: 300 }),
      ],
    });
    const r = await querySoldComps({});
    expect(r.stats.minPrice).toBe(100);
    expect(r.stats.maxPrice).toBe(300);
    expect(r.stats.medianPrice).toBe(200);
    expect(r.stats.meanPrice).toBe(200);
  });

  it("median of even count averages the middle two", async () => {
    mockDocs({
      userId: "u-1",
      ledger: [
        makeSaleEntry({ id: "l-1", unitSalePrice: 100 }),
        makeSaleEntry({ id: "l-2", unitSalePrice: 200 }),
        makeSaleEntry({ id: "l-3", unitSalePrice: 300 }),
        makeSaleEntry({ id: "l-4", unitSalePrice: 400 }),
      ],
    });
    const r = await querySoldComps({});
    expect(r.stats.medianPrice).toBe(250);
  });

  it("respects limit", async () => {
    mockDocs({
      userId: "u-1",
      ledger: [
        makeSaleEntry({ id: "l-1" }),
        makeSaleEntry({ id: "l-2" }),
        makeSaleEntry({ id: "l-3" }),
      ],
    });
    const r = await querySoldComps({ limit: 2 });
    expect(r.count).toBe(2);
  });
});

describe("querySoldComps — cross-user", () => {
  it("aggregates matches across multiple users", async () => {
    mockDocs(
      { userId: "u-1", ledger: [makeSaleEntry({ id: "l-1", unitSalePrice: 100 })] },
      { userId: "u-2", ledger: [makeSaleEntry({ id: "l-2", unitSalePrice: 200 })] },
      { userId: "u-3", ledger: [makeSaleEntry({ id: "l-3", unitSalePrice: 300 })] },
    );
    const r = await querySoldComps({});
    expect(r.count).toBe(3);
    expect(r.stats.medianPrice).toBe(200);
  });
});

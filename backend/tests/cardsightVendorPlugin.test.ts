// CF-CARDSIGHT-RESTORE (2026-07-13) — verify the Cardsight vendor plugin
// behaves correctly on/off the API key configuration.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock the slim client at import boundary so tests never hit the real API.
vi.mock("../src/services/compiq/cardsightSlim.client.js", () => ({
  isCardsightConfigured: vi.fn(),
  searchCatalog: vi.fn(),
  getPricing: vi.fn(),
}));

import { cardsightVendorSource } from "../src/services/compiq/cardsightVendorSource.js";
import {
  isCardsightConfigured,
  searchCatalog,
  getPricing,
} from "../src/services/compiq/cardsightSlim.client.js";

beforeEach(() => {
  vi.mocked(isCardsightConfigured).mockReset();
  vi.mocked(searchCatalog).mockReset();
  vi.mocked(getPricing).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("cardsightVendorSource — graceful when API key absent", () => {
  it("returns null immediately when CARDSIGHT_API_KEY is unset", async () => {
    vi.mocked(isCardsightConfigured).mockReturnValue(false);
    const r = await cardsightVendorSource.resolveCard({
      playerName: "Eric Hartman",
      cardYear: 2026,
      setName: "Bowman",
      parallel: "Blue Refractor",
      cardNumber: "CPA-EHA",
      isAuto: true,
    });
    expect(r).toBeNull();
    // Never called the search or pricing endpoints
    expect(searchCatalog).not.toHaveBeenCalled();
    expect(getPricing).not.toHaveBeenCalled();
  });
});

describe("cardsightVendorSource — with API key configured", () => {
  beforeEach(() => vi.mocked(isCardsightConfigured).mockReturnValue(true));

  it("returns null when search returns no hits (catalog miss)", async () => {
    vi.mocked(searchCatalog).mockResolvedValue([]);
    const r = await cardsightVendorSource.resolveCard({
      playerName: "Some Player",
      cardYear: 2026,
    });
    expect(r).toBeNull();
    expect(getPricing).not.toHaveBeenCalled();
  });

  it("returns resolution with FMV when catalog + pricing both hit", async () => {
    vi.mocked(searchCatalog).mockResolvedValue([
      {
        id: "cs-card-abc",
        name: "Eric Hartman Blue Refractor Auto",
        number: "CPA-EHA",
        releaseName: "2026 Bowman Baseball",
        setName: "2026 Bowman Baseball",
        year: 2026,
        player: "Eric Hartman",
      },
    ]);
    vi.mocked(getPricing).mockResolvedValue({
      card: { card_id: "cs-card-abc" },
      raw: {
        count: 5,
        records: [
          { price: 320, date: "2026-07-05" },
          { price: 350, date: "2026-07-08" },
          { price: 330, date: "2026-07-10" },
          { price: 400, date: "2026-07-11" },
          { price: 380, date: "2026-07-12" },
        ],
      },
      graded: [],
      meta: { total_records: 5, last_sale_date: "2026-07-12" },
    });

    const r = await cardsightVendorSource.resolveCard({
      playerName: "Eric Hartman",
      cardYear: 2026,
      setName: "2026 Bowman Baseball",
      parallel: "Blue Refractor",
      cardNumber: "CPA-EHA",
      isAuto: true,
    });

    expect(r).not.toBeNull();
    expect(r!.vendor).toBe("cardsight");
    expect(r!.cardId).toBe("cs-card-abc");
    expect(r!.fairMarketValue).toBe(350);   // median of 5 prices
    expect(r!.compCount).toBe(5);
    expect(r!.freshestSaleDate).toBe("2026-07-12");
    expect(r!.confidence).toBe("high");   // strong field match on player/year/set/number
  });

  it("returns catalog hit even when pricing errors — signals 'CS knows this card'", async () => {
    vi.mocked(searchCatalog).mockResolvedValue([
      {
        id: "cs-card-xyz",
        name: "Some Card",
        number: "1",
        releaseName: "2020 Set",
        setName: "2020 Set",
        year: 2020,
        player: "Mookie Betts",
      },
    ]);
    vi.mocked(getPricing).mockRejectedValue(new Error("Cardsight down"));

    const r = await cardsightVendorSource.resolveCard({
      playerName: "Mookie Betts",
      cardYear: 2020,
      setName: "2020 Set",
      cardNumber: "1",
    });
    expect(r).not.toBeNull();
    expect(r!.cardId).toBe("cs-card-xyz");
    expect(r!.fairMarketValue).toBeNull();
  });

  it("uses graded pool when query specifies gradeCompany + gradeValue", async () => {
    vi.mocked(searchCatalog).mockResolvedValue([
      {
        id: "cs-card-graded",
        name: "Trout Update RC",
        number: "US175",
        releaseName: "2011 Topps Update",
        setName: "2011 Topps Update",
        year: 2011,
        player: "Mike Trout",
      },
    ]);
    vi.mocked(getPricing).mockResolvedValue({
      raw: { count: 100, records: [{ price: 200, date: "2026-07-01" }] },
      graded: [{
        company_name: "PSA",
        grades: [{
          grade_value: "10",
          count: 3,
          records: [
            { price: 4500, date: "2026-07-01" },
            { price: 5000, date: "2026-07-05" },
            { price: 4750, date: "2026-07-10" },
          ],
        }],
      }],
      meta: { total_records: 103, last_sale_date: "2026-07-10" },
    });

    const r = await cardsightVendorSource.resolveCard({
      playerName: "Mike Trout",
      cardYear: 2011,
      setName: "2011 Topps Update",
      cardNumber: "US175",
      gradeCompany: "PSA",
      gradeValue: 10,
    });

    expect(r!.fairMarketValue).toBe(4750);   // median of PSA 10 records (NOT raw pool)
    expect(r!.compCount).toBe(3);
  });

  it("confidence scales down with weaker field alignment", async () => {
    vi.mocked(searchCatalog).mockResolvedValue([
      {
        id: "cs-partial",
        name: "Random",
        number: "999",
        releaseName: "2019 Random",
        setName: "2019 Random",
        year: 2019,   // year mismatch
        player: "Different",
      },
    ]);
    vi.mocked(getPricing).mockResolvedValue({
      raw: { count: 1, records: [{ price: 50, date: "2026-01-01" }] },
      graded: [],
      meta: { total_records: 1, last_sale_date: "2026-01-01" },
    });

    const r = await cardsightVendorSource.resolveCard({
      playerName: "Mookie Betts",
      cardYear: 2020,
      setName: "Panini Prizm",
      cardNumber: "275",
    });
    expect(r).not.toBeNull();
    expect(r!.confidence).toBe("low");
  });
});

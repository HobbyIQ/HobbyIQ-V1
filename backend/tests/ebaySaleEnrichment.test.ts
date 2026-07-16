// CF-EBAY-SOLD-COMPS-FOUNDATION (2026-07-12): unit tests for the sale-side
// Browse merger. Snapshots the eBay listing's item-specifics onto the
// ledger sale entry so every completed sale becomes a first-class sold-comp.

import { describe, expect, it } from "vitest";
import { applyBrowseEnrichmentToSale } from "../src/services/portfolioiq/ebaySaleEnrichment.service.js";
import type { EbayItemDetails } from "../src/services/ebay/ebayItemDetails.service.js";
import type { PortfolioLedgerEntry } from "../src/services/portfolioiq/portfolioStore.service.js";

function makeSale(overrides: Partial<PortfolioLedgerEntry> = {}): PortfolioLedgerEntry {
  return {
    id: "ledger-1",
    userId: "user-x",
    holdingId: "hold-1",
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
    soldAt: "2026-07-01T00:00:00Z",
    source: "ebay",
    ebayOrderId: "order-1",
    ebayListingId: "407015594876",
    ...overrides,
  } as PortfolioLedgerEntry;
}

function makeDetails(overrides: Partial<EbayItemDetails> = {}): EbayItemDetails {
  return {
    itemId: "v1|407015594876|0",
    legacyItemId: "407015594876",
    title: "2020 Panini Prizm Mookie Betts #275 PSA 10",
    shortDescription: "PSA 10 GEM MINT",
    price: { value: 250, currency: "USD" },
    condition: "Graded",
    grader: "Professional Sports Authenticator (PSA)",
    grade: "10",
    aspects: {
      Player: "Mookie Betts",
      Team: "Los Angeles Dodgers",
      Sport: "Baseball",
      Season: "2020",
      Set: "Panini Prizm",
      Manufacturer: "Panini",
      "Card Number": "275",
    },
    images: {
      primary: "https://i.ebayimg.com/primary.jpg",
      additional: ["https://i.ebayimg.com/back.jpg"],
    },
    categoryPath: "Sports Mem, Cards & Fan Shop|Baseball Cards",
    seller: { username: "topcards", feedbackScore: 15000 },
    itemCreationDate: "2026-06-01T00:00:00Z",
    itemEndDate: null,
    buyingOptions: ["FIXED_PRICE"],
    ...overrides,
  };
}

describe("applyBrowseEnrichmentToSale", () => {
  it("snapshots aspects, images, description, category, seller onto the sale", () => {
    const s = makeSale();
    applyBrowseEnrichmentToSale(s, makeDetails());
    expect(s.ebayItemAspects?.Team).toBe("Los Angeles Dodgers");
    expect(s.ebayItemAspects?.["Card Number"]).toBe("275");
    expect(s.ebayImageUrl).toBe("https://i.ebayimg.com/primary.jpg");
    expect(s.ebaySoldImages).toHaveLength(2);
    expect(s.ebayShortDescription).toBe("PSA 10 GEM MINT");
    expect(s.ebayCategoryPath).toMatch(/Baseball Cards/);
    expect(s.ebaySellerUsername).toBe("topcards");
    expect(s.enrichedFromEbay).toBe(true);
  });

  it("no aspects + no images + no category → enrichedFromEbay stays false", () => {
    const s = makeSale();
    const d = makeDetails({
      aspects: {},
      images: { primary: null, additional: [] },
      categoryPath: null,
    });
    applyBrowseEnrichmentToSale(s, d);
    expect(s.enrichedFromEbay).toBeFalsy();
    expect(s.ebayItemAspects).toBeUndefined();
  });

  it("does not touch sale financials (grossProceeds, netProceeds, fees)", () => {
    const s = makeSale({ grossProceeds: 250, netProceeds: 225, fees: 25 });
    applyBrowseEnrichmentToSale(s, makeDetails());
    expect(s.grossProceeds).toBe(250);
    expect(s.netProceeds).toBe(225);
    expect(s.fees).toBe(25);
  });

  it("aspects are the full snapshot — no field pruning", () => {
    const s = makeSale();
    const aspects: Record<string, string> = {
      Foo: "1",
      Bar: "2",
      Baz: "3",
      Qux: "4",
    };
    applyBrowseEnrichmentToSale(s, makeDetails({ aspects }));
    expect(Object.keys(s.ebayItemAspects ?? {})).toEqual(["Foo", "Bar", "Baz", "Qux"]);
  });
});

// CF-EBAY-BROWSE-ENRICHMENT (2026-07-12): unit tests for the Browse API
// merger. Browse-side data must beat title-parse for grader/grade/autograph,
// and previously-empty structured fields must backfill.

import { describe, expect, it } from "vitest";
import { applyBrowseEnrichment } from "../src/services/portfolioiq/ebayAutoHolding.service.js";
import type { EbayItemDetails } from "../src/services/ebay/ebayItemDetails.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.js";

function makeHolding(overrides: Record<string, unknown> = {}): PortfolioHolding &
  Record<string, unknown> {
  return {
    id: "hold-1",
    quantity: 1,
    purchasePrice: 100,
    totalCostBasis: 100,
    purchaseDate: "2026-07-01",
    lastUpdated: "2026-07-01T00:00:00Z",
    parseConfidence: 0.75,
    needsReview: true,
    ...overrides,
  } as any;
}

function makeDetails(overrides: Partial<EbayItemDetails> = {}): EbayItemDetails {
  return {
    itemId: "v1|407015594876|0",
    legacyItemId: "407015594876",
    title: "2023 Bowman Chrome CJ Kayfus Blue Refractor Auto RC PSA 10",
    shortDescription: "PSA 10 GEM MINT — signed rookie parallel /150",
    price: { value: 349.99, currency: "USD" },
    condition: "Graded",
    grader: "Professional Sports Authenticator (PSA)",
    grade: "10",
    aspects: {
      Player: "CJ Kayfus",
      Team: "Cleveland Guardians",
      Sport: "Baseball",
      Season: "2023",
      Set: "Bowman Chrome",
      Manufacturer: "Topps",
      "Card Number": "CPA-CK",
      "Parallel/Variety": "Blue Refractor",
      Autographed: "Yes",
      Grade: "10",
      "Professional Grader": "Professional Sports Authenticator (PSA)",
    },
    images: {
      primary: "https://i.ebayimg.com/image/abc.jpg",
      additional: [
        "https://i.ebayimg.com/image/def.jpg",
        "https://i.ebayimg.com/image/ghi.jpg",
      ],
    },
    categoryPath: "Sports Mem, Cards & Fan Shop|Sports Trading Cards|Baseball Cards",
    seller: { username: "topcardstore", feedbackScore: 15423 },
    itemCreationDate: "2026-06-01T00:00:00Z",
    itemEndDate: null,
    buyingOptions: ["FIXED_PRICE"],
    ...overrides,
  };
}

describe("applyBrowseEnrichment — Browse is authoritative for grader/grade", () => {
  it("normalizes grader alias (Professional Sports Authenticator (PSA) → PSA)", () => {
    const h = makeHolding();
    applyBrowseEnrichment(h, makeDetails());
    expect(h.gradeCompany).toBe("PSA");
    expect((h as any).gradingCompany).toBe("PSA");
    expect(h.gradeValue).toBe(10);
  });

  it("overrides a wrong title-parsed grader with Browse-authoritative grader", () => {
    const h = makeHolding({ gradeCompany: "BGS", gradeValue: 9.5 });
    applyBrowseEnrichment(h, makeDetails());
    expect(h.gradeCompany).toBe("PSA");
    expect(h.gradeValue).toBe(10);
  });

  it("clears a title-parsed grade when Browse says Ungraded", () => {
    const h = makeHolding({ gradeCompany: "PSA", gradeValue: 10 });
    const d = makeDetails({
      condition: "Ungraded",
      grader: null,
      grade: null,
      aspects: { Player: "CJ Kayfus" },
    });
    applyBrowseEnrichment(h, d);
    expect(h.gradeCompany).toBeUndefined();
    expect(h.gradeValue).toBeUndefined();
  });
});

describe("applyBrowseEnrichment — autograph aspect authoritative", () => {
  it("sets isAuto=true when Browse Autographed=Yes", () => {
    const h = makeHolding({ isAuto: false });
    applyBrowseEnrichment(h, makeDetails());
    expect(h.isAuto).toBe(true);
  });

  it("sets isAuto=false when Browse Autographed=No overriding title parse", () => {
    const h = makeHolding({ isAuto: true });
    const d = makeDetails({ aspects: { ...makeDetails().aspects, Autographed: "No" } });
    applyBrowseEnrichment(h, d);
    expect(h.isAuto).toBe(false);
  });
});

describe("applyBrowseEnrichment — backfills missing structured fields", () => {
  it("backfills player, team, sport, set, parallel, cardNumber when absent", () => {
    const h = makeHolding();
    applyBrowseEnrichment(h, makeDetails());
    expect(h.playerName).toBe("CJ Kayfus");
    expect((h as any).team).toBe("Cleveland Guardians");
    expect((h as any).sport).toBe("Baseball");
    expect(h.setName).toBe("Bowman Chrome");
    expect(h.parallel).toBe("Blue Refractor");
    expect(h.cardNumber).toBe("CPA-CK");
    expect((h as any).manufacturer).toBe("Topps");
  });

  it("Browse is AUTHORITATIVE — overrides polluted title-parsed player/set/parallel", () => {
    // Title parser produced messy values ("Baseball Owen Carey" is a real
    // 2026-07-12 example from Drew's data — parser grabbed the vertical
    // marker as part of the name). Browse's structured Player aspect
    // must win.
    const h = makeHolding({
      playerName: "Baseball Owen Carey",       // polluted by title parser
      setName: "Some Old Set",
      parallel: "wrong-parallel",
    });
    applyBrowseEnrichment(h, makeDetails());
    expect(h.playerName).toBe("CJ Kayfus");         // Browse wins
    expect(h.setName).toBe("Bowman Chrome");        // Browse wins
    expect(h.parallel).toBe("Blue Refractor");      // Browse wins
    expect((h as any).team).toBe("Cleveland Guardians");
  });

  it("cardNumber is the ONE exception — title's coded form is preserved", () => {
    // Title carries "BCP-14" (parallel-specific code); Browse aspect
    // often has "14" alone. Preserving title here is intentional.
    const h = makeHolding({ cardNumber: "BCP-14" });
    applyBrowseEnrichment(h, makeDetails());
    expect(h.cardNumber).toBe("BCP-14");
  });

  it("backfills cardYear from Season aspect when missing", () => {
    const h = makeHolding();
    applyBrowseEnrichment(h, makeDetails());
    expect(h.cardYear).toBe(2023);
  });
});

describe("applyBrowseEnrichment — images, description, category, seller", () => {
  it("assembles photos array from primary + additional images", () => {
    const h = makeHolding();
    applyBrowseEnrichment(h, makeDetails());
    expect((h as any).photos).toHaveLength(3);
    expect((h as any).ebayImageUrl).toBe("https://i.ebayimg.com/image/abc.jpg");
  });

  it("preserves ebay-relisting fields on holding for iOS + resale", () => {
    const h = makeHolding();
    applyBrowseEnrichment(h, makeDetails());
    expect((h as any).ebayShortDescription).toMatch(/PSA 10/);
    expect((h as any).ebayItemAspects.Player).toBe("CJ Kayfus");
    expect((h as any).ebayCategoryPath).toMatch(/Baseball Cards/);
    expect((h as any).ebaySeller.username).toBe("topcardstore");
  });
});

describe("applyBrowseEnrichment — confidence bump", () => {
  it("bumps confidence to 0.95 and clears needsReview when structured data merged", () => {
    const h = makeHolding({ parseConfidence: 0.68, needsReview: true });
    applyBrowseEnrichment(h, makeDetails());
    expect((h as any).parseConfidence).toBe(0.95);
    expect((h as any).needsReview).toBe(false);
    expect((h as any).enrichedFromEbay).toBe(true);
  });

  it("does NOT drop confidence below original when eBay returned no aspects", () => {
    const h = makeHolding({ parseConfidence: 0.92, needsReview: false });
    const d = makeDetails({
      aspects: {},
      grader: null,
      grade: null,
      condition: null,
    });
    applyBrowseEnrichment(h, d);
    expect((h as any).parseConfidence).toBe(0.92);
    expect((h as any).enrichedFromEbay).toBeUndefined();
  });
});

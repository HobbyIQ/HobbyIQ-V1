/**
 * CF-NO-IDENTITY-NO-PRICE-AT-THE-DOOR (2026-08-23).
 *
 * CF-NO-IDENTITY-NO-PRICE shipped 2026-08-22 inside autoPriceHolding. The next
 * day the exact card it was written for was still wrong:
 *
 *   Max Williams "2025 Bowman Draft Gold #CPA-MWI" (aff3236a, $301.43 paid)
 *     cardId            absent
 *     catalogMatchSlug  hiq:baseball:2025:bowman-draft:cpa-mwi:gold:auto:num-50
 *     fairMarketValue   14.29        (4.7% of cost basis)
 *     valuationStatus   "observed"
 *     pricingSource     "legacy-engine"   sourceVendor "cardsight"
 *     lastUpdated       2026-08-23T18:59:08Z
 *
 * The 2026-08-22 guard is correct where it sits — it cannot write that number.
 * Another of the 22 fairMarketValue assignments in portfolioStore did. So the
 * check moved to writeUserDoc, which every path must pass through.
 *
 * THE NEGATIVE CASES CARRY THE WEIGHT. A guard at a choke point sees every
 * holding, so the ways it can be too aggressive matter as much as the ways it
 * can be too lax: it must not blank an identified holding, must not resurrect
 * or invent a price, and must leave a holding that never had a price alone
 * rather than churning the document.
 */
import { describe, expect, it } from "vitest";
import { withholdPricesFromUnidentifiedHoldings } from "../src/services/portfolioiq/portfolioStore.service.js";

const doc = (holdings: Record<string, any>) => ({ id: "user-x", userId: "x", holdings } as any);

/** The real shape, reduced to the fields the invariant reasons about. */
const GOLD = {
  id: "aff3236a",
  playerName: "Max Williams",
  cardNumber: "CPA-MWI",
  parallel: "Gold",
  purchasePrice: 301.43,
  totalCostBasis: 301.43,
  catalogMatchSlug: "hiq:baseball:2025:bowman-draft:cpa-mwi:gold:auto:num-50",
  catalogMatchConfidence: 0.72,
  fairMarketValue: 14.29,
  valuationStatus: "observed",
  isEstimate: false,
  pricingSource: "legacy-engine",
  sourceVendor: "cardsight",
};

describe("a holding with no identity cannot carry a price through the door", () => {
  it("withholds the value surface on the real Max Williams Gold shape", () => {
    const out: any = withholdPricesFromUnidentifiedHoldings(doc({ aff3236a: { ...GOLD } }));
    const h = out.holdings.aff3236a;
    expect(h.fairMarketValue).toBeNull();
    expect(h.estimatedValue).toBeNull();
    expect(h.isEstimate).toBe(false);
  });

  it("clears the 'observed' claim — a withheld price is not an observation", () => {
    const out: any = withholdPricesFromUnidentifiedHoldings(doc({ aff3236a: { ...GOLD } }));
    expect(out.holdings.aff3236a.valuationStatus).toBeNull();
  });

  it("flags it for review with the reason the user sees", () => {
    const out: any = withholdPricesFromUnidentifiedHoldings(doc({ aff3236a: { ...GOLD } }));
    expect(out.holdings.aff3236a.needsReview).toBe(true);
    expect(String(out.holdings.aff3236a.reviewReason)).toContain("could not identify");
  });

  it("does NOT destroy the parked catalog match — that is the answer we still need", () => {
    const out: any = withholdPricesFromUnidentifiedHoldings(doc({ aff3236a: { ...GOLD } }));
    expect(out.holdings.aff3236a.catalogMatchSlug)
      .toBe("hiq:baseball:2025:bowman-draft:cpa-mwi:gold:auto:num-50");
    expect(out.holdings.aff3236a.catalogMatchConfidence).toBe(0.72);
  });

  it("catches an estimate too, not just a fair market value", () => {
    const out: any = withholdPricesFromUnidentifiedHoldings(
      doc({ h: { id: "h", estimatedValue: 12.5, isEstimate: true } }),
    );
    expect(out.holdings.h.estimatedValue).toBeNull();
    expect(out.holdings.h.needsReview).toBe(true);
  });

  it("treats empty-string and whitespace identity as unidentified", () => {
    for (const bad of [{ cardId: "" }, { cardId: "   " }, { hobbyiqCardId: "\t" }]) {
      const out: any = withholdPricesFromUnidentifiedHoldings(
        doc({ h: { id: "h", ...bad, fairMarketValue: 99 } }),
      );
      expect(out.holdings.h.fairMarketValue, JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("it must not touch anything else", () => {
  it("leaves an IDENTIFIED holding's price completely alone", () => {
    const ok = {
      id: "deced7d3",
      cardId: "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto",
      fairMarketValue: 15.49,
      valuationStatus: "observed",
      isEstimate: false,
    };
    const out: any = withholdPricesFromUnidentifiedHoldings(doc({ deced7d3: { ...ok } }));
    expect(out.holdings.deced7d3).toEqual(ok);
  });

  it("accepts a canonical slug alone as identity (hiq: holdings carry no vendor id)", () => {
    const ok = {
      id: "h",
      cardId: null,
      hobbyiqCardId: "hiq:baseball:1997:topps-finest:238:base:no-auto",
      fairMarketValue: 60.73,
    };
    const out: any = withholdPricesFromUnidentifiedHoldings(doc({ h: { ...ok } }));
    expect(out.holdings.h.fairMarketValue).toBe(60.73);
  });

  it("returns the SAME doc object when nothing needed withholding", () => {
    // No churn: an untouched portfolio must not be rewritten on every save.
    const d = doc({ h: { id: "h", cardId: "hiq:x", fairMarketValue: 10 } });
    expect(withholdPricesFromUnidentifiedHoldings(d)).toBe(d);
  });

  it("leaves an unidentified holding that never had a price alone", () => {
    const d = doc({ h: { id: "h", playerName: "Nobody" } });
    expect(withholdPricesFromUnidentifiedHoldings(d)).toBe(d);
  });

  it("never invents a price — it withholds, it does not substitute", () => {
    const out: any = withholdPricesFromUnidentifiedHoldings(
      doc({ h: { id: "h", fairMarketValue: 14.29 } }),
    );
    // Explicitly null, not 0 and not some fallback figure: the absence has to
    // be legible downstream as "we have no number", not as a number.
    expect(out.holdings.h.fairMarketValue).toBeNull();
    expect(out.holdings.h.estimatedValue).toBeNull();
  });

  it("survives malformed input without throwing", () => {
    expect(() => withholdPricesFromUnidentifiedHoldings({} as any)).not.toThrow();
    expect(() => withholdPricesFromUnidentifiedHoldings(doc({ h: null }))).not.toThrow();
    expect(() => withholdPricesFromUnidentifiedHoldings({ holdings: [] } as any)).not.toThrow();
  });

  it("leaves other holdings in the doc untouched while withholding one", () => {
    const out: any = withholdPricesFromUnidentifiedHoldings(doc({
      bad: { id: "bad", fairMarketValue: 14.29 },
      good: { id: "good", cardId: "hiq:y", fairMarketValue: 15.49 },
    }));
    expect(out.holdings.bad.fairMarketValue).toBeNull();
    expect(out.holdings.good.fairMarketValue).toBe(15.49);
  });
});

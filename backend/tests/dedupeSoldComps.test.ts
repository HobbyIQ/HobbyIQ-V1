/**
 * CF-DEDUPE-SOLD-COMPS (2026-08-22).
 *
 * The same sale reaches sold_comps up to three times — cardsight, cardhedge
 * and tca-ebay all ingest the same eBay transaction, and cardhedge writes it
 * twice at different timestamp precision:
 *
 *   $2,146.21 on 07-14   cardsight@23:30:01  cardhedge@23:35:26  cardhedge@23:35:00
 *
 * That is not a counting problem. unifiedPricing's leading edge is the median
 * of the LAST 3 SALES, so two copies of one sale outvote everything else and
 * become the answer — which is how Ohtani 2018 BC #1 reported "-9.7% falling"
 * while its own 224 PSA 9 sales rose +16%/month.
 *
 * The tests below pin the three ways this can go wrong: merging sales that are
 * genuinely different, chain-collapsing a run of real sales, and silently
 * dropping rows it cannot key.
 */
import { describe, it, expect } from "vitest";
import { dedupeSoldComps, countSoldCompDuplicates } from "../src/services/portfolioiq/dedupeSoldComps.js";

const at = (iso: string, price: number, extra: Record<string, unknown> = {}) =>
  ({ price, soldAt: iso, ...extra });

describe("dedupeSoldComps — collapsing one sale seen many times", () => {
  it("collapses the real Ohtani case: same price, minutes apart, three sources", () => {
    const rows = [
      at("2026-07-14T23:30:01Z", 2146.21, { source: "cardsight" }),
      at("2026-07-14T23:35:26Z", 2146.21, { source: "cardhedge" }),
      at("2026-07-14T23:35:00Z", 2146.21, { source: "cardhedge" }),
    ];
    const out = dedupeSoldComps(rows);
    expect(out).toHaveLength(1);
    // Earliest survives — the record closest to the sale itself.
    expect(out[0].source).toBe("cardsight");
  });

  it("KEEPS two sales of the same card at the same price hours apart", () => {
    // The over-merge failure. Beyond the window these are real, separate sales
    // and collapsing them understates volume and distorts the trend.
    const rows = [
      at("2026-07-14T01:00:00Z", 2000),
      at("2026-07-14T20:00:00Z", 2000),
    ];
    expect(dedupeSoldComps(rows)).toHaveLength(2);
  });

  it("KEEPS different grades that share a price and a moment", () => {
    // A raw and a PSA 10 at $2,000 are two sales, not one.
    const rows = [
      at("2026-07-14T23:30:00Z", 2000, { gradeCompany: null }),
      at("2026-07-14T23:31:00Z", 2000, { gradeCompany: "PSA", gradeValue: 10 }),
    ];
    expect(dedupeSoldComps(rows)).toHaveLength(2);
  });

  it("KEEPS different prices at the same moment", () => {
    const rows = [
      at("2026-07-14T23:30:00Z", 2000),
      at("2026-07-14T23:30:00Z", 2100),
    ];
    expect(dedupeSoldComps(rows)).toHaveLength(2);
  });

  it("does not CHAIN-collapse a dense run of real sales", () => {
    // Five sales 45 minutes apart. Each is inside 60m of the PREVIOUS one, so
    // anchoring on the previous row would swallow all five into one. Anchoring
    // on the cluster start keeps the window bounded.
    const rows = [
      at("2026-07-14T00:00:00Z", 2000),
      at("2026-07-14T00:45:00Z", 2000),
      at("2026-07-14T01:30:00Z", 2000),
      at("2026-07-14T02:15:00Z", 2000),
      at("2026-07-14T03:00:00Z", 2000),
    ];
    const out = dedupeSoldComps(rows);
    expect(out.length).toBeGreaterThan(1);
    expect(out).toHaveLength(3);   // 00:00, 01:30, 03:00
  });

  it("PASSES THROUGH rows it cannot key rather than dropping them", () => {
    // This function removes duplicates; it must never quietly filter the pool.
    const rows = [
      at("not-a-date", 2000),
      at("2026-07-14T23:30:00Z", 0),
      at("2026-07-14T23:30:00Z", 2000),
    ];
    expect(dedupeSoldComps(rows)).toHaveLength(3);
  });

  it("is a no-op on already-unique rows", () => {
    const rows = [
      at("2026-07-01T10:00:00Z", 1000),
      at("2026-07-02T10:00:00Z", 1100),
      at("2026-07-03T10:00:00Z", 1200),
    ];
    expect(dedupeSoldComps(rows)).toHaveLength(3);
    expect(countSoldCompDuplicates(rows)).toBe(0);
  });

  it("tolerates the mixed soldAt formats the pool actually stores", () => {
    // sold_comps carries both "+00:00" and ".000Z" shapes for the same card.
    const rows = [
      at("2026-07-14T23:30:00+00:00", 2146.21),
      at("2026-07-14T23:35:00.000Z", 2146.21),
    ];
    expect(dedupeSoldComps(rows)).toHaveLength(1);
  });

  it("handles empty and single-row input", () => {
    expect(dedupeSoldComps([])).toEqual([]);
    expect(dedupeSoldComps([at("2026-07-14T23:30:00Z", 5)])).toHaveLength(1);
  });
});

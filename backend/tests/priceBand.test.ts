// CF-PRICE-BAND-FROM-DISPERSION. Pins the rule that decides whether a real
// sale reaches sold_comps.
//
// status=anomaly means promotion (which reads status IN ('clean','verified'))
// never picks the row up, so every false positive here is a permanently lost
// price point. Measured 2026-08-13 on a 30,000-row anomaly sample:
// price-outlier was 46.6% of the pile, dominated by vintage RAW rows whose
// dispersion is genuine condition variance, not bad data.

import { describe, expect, it } from "vitest";
import {
  priceBandFromSorted,
  priceOutlierDetail,
} from "../src/services/portfolioiq/dataCleanJob.service.js";

/** Ascending prices, as the callers always pass them. */
const asc = (...p: number[]) => p.sort((a, b) => a - b);

describe("priceBandFromSorted", () => {
  it("returns no band below the sample floor — an unjudgeable row is not an anomaly", () => {
    // Quantiles need more support than a median. This extends the rule the
    // job already applies to thin grade tiers rather than guessing a band.
    expect(priceBandFromSorted(asc(1, 2, 3, 4, 5, 6, 7))).toBeNull();
    expect(priceBandFromSorted([])).toBeNull();
  });

  it("builds a band once there is enough support", () => {
    const band = priceBandFromSorted(asc(1, 2, 3, 4, 5, 6, 7, 8));
    expect(band).not.toBeNull();
    expect(band!.n).toBe(8);
    expect(band!.lo).toBeLessThanOrEqual(band!.median);
    expect(band!.median).toBeLessThanOrEqual(band!.hi);
  });

  it("puts lo/hi at the tails, not at the extremes", () => {
    // p10/p90 must be robust to a single absurd value, or one bad row would
    // widen the band enough to admit the next bad row.
    const band = priceBandFromSorted(asc(10, 11, 12, 13, 14, 15, 16, 17, 18, 100_000));
    expect(band!.hi).toBeLessThan(1000);
  });
});

describe("priceOutlierDetail", () => {
  /** A tight modern pool: everything clusters near $100. */
  const tight = priceBandFromSorted(asc(95, 96, 98, 99, 100, 101, 102, 104, 105, 110))!;

  /** A vintage RAW pool: a $3 beater through a $600 near-mint copy, all in
   *  the same "raw" bucket because the slug has no condition dimension. */
  const vintageRaw = priceBandFromSorted(asc(3, 5, 8, 12, 20, 45, 90, 180, 350, 600))!;

  it("passes an in-band sale", () => {
    expect(priceOutlierDetail(100, tight)).toBeNull();
    expect(priceOutlierDetail(45, vintageRaw)).toBeNull();
  });

  it("keeps a tight pool tight — 10x on clustered comps still trips", () => {
    // The check must not become toothless: where the pool really is uniform,
    // a wild price is still caught.
    expect(priceOutlierDetail(1000, tight)).toContain("outside");
    expect(priceOutlierDetail(1, tight)).toContain("outside");
  });

  it("stops branding vintage-raw condition variance as bad data", () => {
    // The regression this exists for. Under the old median/3..median*3 rule
    // the vintage median (~$32) banded to roughly $11-$97, so a perfectly
    // ordinary $350 near-mint sale and a $5 beater were BOTH anomalies.
    const oldMedian = vintageRaw.median;
    expect(350 / oldMedian).toBeGreaterThan(3);   // old rule: outlier
    expect(5 / oldMedian).toBeLessThan(1 / 3);    // old rule: outlier
    expect(priceOutlierDetail(350, vintageRaw)).toBeNull();  // new rule: a sale
    expect(priceOutlierDetail(5, vintageRaw)).toBeNull();
  });

  it("still catches what the check is FOR, even on a dispersed pool", () => {
    // Lot listings, typos and wrong-card matches sit orders of magnitude
    // outside the observed range, not inside its tail.
    expect(priceOutlierDetail(50_000, vintageRaw)).toContain("outside");
    expect(priceOutlierDetail(0.25, vintageRaw)).toContain("outside");
  });

  it("scales the band with the pool's own spread", () => {
    // Same median, different dispersion → different verdict for the same price.
    const spread = priceBandFromSorted(asc(10, 20, 40, 60, 100, 140, 200, 400, 800, 1600))!;
    const clustered = priceBandFromSorted(asc(96, 98, 99, 100, 100, 101, 102, 103, 104, 106))!;
    expect(priceOutlierDetail(900, spread)).toBeNull();
    expect(priceOutlierDetail(900, clustered)).toContain("outside");
  });

  it("reports the band it judged against, including sample size", () => {
    // Detail is what triage reads; a bare percentage hid which pool was used.
    const d = priceOutlierDetail(50_000, vintageRaw)!;
    expect(d).toContain("p10-p90");
    expect(d).toContain("n=10");
    expect(d).toContain("50000.00");
  });
});

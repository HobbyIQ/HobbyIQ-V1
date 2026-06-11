// CF-GRADED-PRICE-PROJECTION (2026-06-12) — Phase 1a unit coverage for
// computeGradedProjection. Fixtures mirror the Phase 0 recon medians for
// Leo De Vries (modern thin coverage) and Mike Trout 2011 Topps Update
// (liquid coverage with Cardsight's duplicate-grade-bucket quirk).

import { describe, it, expect } from "vitest";
import {
  computeGradedProjection,
  TARGET_GRADES,
  type GradedProjectionResult,
} from "../src/services/compiq/gradedPriceProjection.js";
import type {
  CardsightPricingResponse,
  CardsightSaleRecord,
} from "../src/services/compiq/cardsight.client.js";

// ─── Fixture helpers ───────────────────────────────────────────────────────

function rec(
  title: string,
  price: number,
  opts: { parallel_id?: string | null; listing_type?: string | null } = {},
): CardsightSaleRecord {
  return {
    title,
    price,
    date: "2026-05-15T00:00:00Z",
    source: "ebay",
    url: null,
    parallel_id: opts.parallel_id ?? null,
    listing_type: opts.listing_type ?? null,
  } as CardsightSaleRecord;
}

function gradedBucket(grade_value: string | number, records: CardsightSaleRecord[]) {
  return { grade_value, count: records.length, records };
}

function makeLeoPricing(): CardsightPricingResponse {
  // 24 BASE raw records spanning $200-$260 to produce median ≈ $228.93,
  // plus 6 parallel records (1 Blue Refractor (parallel_id null), 3
  // Speckle, 1 Blue Wave, 1 Green Reptilian) that must be excluded from
  // base computations.
  const baseRaw: CardsightSaleRecord[] = [];
  // Build 24 records targeting median = $228.93 — symmetric around the
  // midpoint of the sorted array.
  const prices = [
    200, 210, 215, 218, 220, 222, 224, 226,
    227, 228, 228.5, 228.86,                   // ← 12th index
    229,    229.5, 230, 232, 234, 236, 238, 242,
    246, 250, 255, 260,
  ];
  // sort guard — produce a median of (228.86 + 229) / 2 ≈ 228.93
  prices.sort((a, b) => a - b);
  for (let i = 0; i < prices.length; i++) {
    baseRaw.push(rec(
      `2024 Bowman Chrome 1st Autograph Leo De Vries #CPA-LD (base ${i})`,
      prices[i],
    ));
  }
  const parallelRaw: CardsightSaleRecord[] = [
    rec(
      "LEO DE VRIES 2024 BOWMAN CHROME #CPA-LD 1ST PROSPECT BLUE REFRACTOR AUTO 30/150",
      1183,
      { parallel_id: null, listing_type: "auction" },
    ),
    rec(
      "Leo De Vries 2024 Bowman Chrome #CPA-LD Speckle Refractor Auto /299 a",
      450,
      { parallel_id: "7da08907-87ec-4646-900a-f27a3b5d5177" },
    ),
    rec(
      "Leo De Vries 2024 Bowman Chrome #CPA-LD Speckle Refractor Auto /299 b",
      460,
      { parallel_id: "7da08907-87ec-4646-900a-f27a3b5d5177" },
    ),
    rec(
      "Leo De Vries 2024 Bowman Chrome #CPA-LD Speckle Refractor Auto /299 c",
      475,
      { parallel_id: "7da08907-87ec-4646-900a-f27a3b5d5177" },
    ),
    rec(
      "2024 Bowman Chrome 1st Autograph Leo De Vries #CPA-LD Blue Wave Refractor /150",
      285,
      { parallel_id: "f7586330-5ff8-4a0f-be9d-0af36f10ff52", listing_type: "auction" },
    ),
    rec(
      "2024 Bowman Chrome Green Reptilian Refractor 25/99 Leo De Vries #CPA-LD Auto",
      850,
      { parallel_id: "d08a89c9-4755-4186-948b-499fc518620b" },
    ),
  ];

  // 11 PSA 9 BASE records → median ≈ $220.05
  const psa9Base: CardsightSaleRecord[] = [
    195, 205, 210, 215, 218, 220.05, 222, 224, 228, 232, 240,
  ].map((p, i) => rec(
    `2024 Bowman Chrome 1st Autograph Leo De Vries #CPA-LD PSA 9 base ${i}`,
    p,
  ));

  // PSA 10: 9 BASE records → median = $586; 1 parallel at $1,299.99 → must NOT
  // contaminate the base ratio.
  const psa10Base: CardsightSaleRecord[] = [
    520, 545, 560, 575, 586, 596, 610, 625, 640,
  ].map((p, i) => rec(
    `2024 Bowman Chrome 1st Autograph Leo De Vries #CPA-LD PSA 10 base ${i}`,
    p,
  ));
  const psa10Parallel: CardsightSaleRecord = rec(
    "Leo De Vries 2024 Bowman Chrome #CPA-LD Blue Refractor /150 PSA 10",
    1299.99,
    { parallel_id: null },
  );

  // SGC 9 — 1 parallel record only; tier 1 must miss.
  const sgc9Parallel: CardsightSaleRecord = rec(
    "Leo De Vries 2024 Bowman Chrome Speckle Refractor Auto /299 SGC 9",
    390,
    { parallel_id: "7da08907-87ec-4646-900a-f27a3b5d5177" },
  );

  return {
    card: {
      card_id: "ffc4f323-5d6d-4762-922d-286d9fac6da7",
      name: "Leo De Vries",
      number: "CPA-LD",
      set: {
        set_id: "a8914685-6602-4458-82b6-91039ca969f3",
        name: "Prospects Autographs",
        year: "2024",
        release: "Bowman Chrome",
      },
    } as any,
    raw: {
      count: baseRaw.length + parallelRaw.length,
      records: [...baseRaw, ...parallelRaw],
    },
    graded: [
      {
        company_name: "PSA",
        grades: [
          gradedBucket(9, psa9Base),
          gradedBucket(10, [...psa10Base, psa10Parallel]),
        ],
      },
      {
        company_name: "SGC",
        grades: [gradedBucket(9, [sgc9Parallel])],
      },
    ],
    meta: {
      total_records: baseRaw.length + parallelRaw.length + psa9Base.length + psa10Base.length + 1 + 1,
      last_sale_date: "2026-06-10T00:45:00Z",
    },
  } as CardsightPricingResponse;
}

function makeTroutPricing(): CardsightPricingResponse {
  // Trout 2011 Topps Update — coverage profile per the recon:
  //   RAW: 136 base out of 157 — baseMed = $299.995
  //   PSA 10 base n=202, baseMed=$1003.50
  //   PSA 9  base n=101, baseMed=$399.99  AND a DUPLICATE entry n=3 → must merge
  //   BGS 9.5 base n=50, baseMed=$625
  //   SGC 10 base n=2 — below tier-1 threshold (3) → falls to market
  //
  // Reduced sample sizes for fixture clarity, preserving the medians +
  // the dup-bucket quirk + the SGC 10 below-threshold case.

  function evenMedian(n: number, m: number): number[] {
    // Build n prices with median = m. Symmetric construction.
    const half = Math.floor(n / 2);
    const arr: number[] = [];
    if (n % 2 === 1) {
      arr.push(m);
      for (let i = 1; i <= half; i++) {
        arr.push(m - i * 10);
        arr.push(m + i * 10);
      }
    } else {
      const lo = m - 5;
      const hi = m + 5;
      arr.push(lo, hi);
      for (let i = 1; i < half; i++) {
        arr.push(lo - i * 10);
        arr.push(hi + i * 10);
      }
    }
    return arr;
  }

  const baseRaw = evenMedian(13, 299.995).map((p, i) => rec(
    `2011 Topps Update Mike Trout RC #US175 base ${i}`,
    p,
  ));
  // Add a few parallel records to confirm exclusion.
  const parallelRaw = [
    rec("2011 Topps Update Mike Trout US175 Gold Refractor /50", 12000, { parallel_id: "p-gold-50" }),
    rec("2011 Topps Update Mike Trout US175 Blue Refractor /175", 4500),
  ];

  // PSA 10 — 11 records, median $1003.50, all base
  const psa10Base = evenMedian(11, 1003.5).map((p, i) => rec(
    `2011 Topps Update Mike Trout RC #US175 PSA 10 base ${i}`,
    p,
  ));

  // PSA 9 — DUPLICATE bucket quirk: 5 records under bucket A + 3 records
  // under bucket B (separate grades[] entries with the same Number(grade_value)).
  // Concatenated, n=8, base median = $399.99. selectSalesByGrade's
  // dup-bucket merge folds both into a single 8-record pool.
  const psa9BucketA = evenMedian(5, 399.99).map((p, i) => rec(
    `2011 Topps Update Mike Trout RC #US175 PSA 9 bucket-A ${i}`,
    p,
  ));
  const psa9BucketB = [388, 405, 412].map((p, i) => rec(
    `2011 Topps Update Mike Trout RC #US175 PSA 9 bucket-B ${i}`,
    p,
  ));

  // BGS 9.5 — 7 records, median $625, all base
  const bgs95Base = evenMedian(7, 625).map((p, i) => rec(
    `2011 Topps Update Mike Trout RC #US175 BGS 9.5 base ${i}`,
    p,
  ));

  // SGC 10 — only 2 base records (below tier-1 threshold) → falls back to market
  const sgc10Base = [700, 735].map((p, i) => rec(
    `2011 Topps Update Mike Trout RC #US175 SGC 10 base ${i}`,
    p,
  ));

  return {
    card: {
      card_id: "fda530ab-e925-460e-ab88-63199ef975e9",
      name: "Mike Trout",
      number: "US175",
      set: {
        set_id: "9d4173f3-09af-49c2-a719-ba11824fd207",
        name: "Base Set",
        year: "2011",
        release: "Topps Update",
      },
    } as any,
    raw: {
      count: baseRaw.length + parallelRaw.length,
      records: [...baseRaw, ...parallelRaw],
    },
    graded: [
      {
        company_name: "PSA",
        grades: [
          gradedBucket(10, psa10Base),
          // Two PSA 9 entries — Cardsight's duplicate-bucket quirk
          gradedBucket(9, psa9BucketA),
          gradedBucket(9, psa9BucketB),
        ],
      },
      {
        company_name: "BGS",
        grades: [gradedBucket("9.5", bgs95Base)],
      },
      {
        company_name: "SGC",
        grades: [gradedBucket(10, sgc10Base)],
      },
    ],
    meta: {
      total_records: baseRaw.length + parallelRaw.length + psa10Base.length + psa9BucketA.length + psa9BucketB.length + bgs95Base.length + sgc10Base.length,
      last_sale_date: "2026-06-09T00:00:00Z",
    },
  } as CardsightPricingResponse;
}

// ─── Common assertions ────────────────────────────────────────────────────

function expectAllFmvNull(results: GradedProjectionResult[]): void {
  for (const r of results) {
    expect(r.marketValue).toBeNull();
    expect(r.fairMarketValue).toBeNull();
    expect(r.isEstimate).toBe(true);
  }
}

function byGrade(results: GradedProjectionResult[], label: string): GradedProjectionResult {
  const found = results.find((r) => r.grade === label);
  expect(found, `result for ${label} missing`).toBeDefined();
  return found!;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("CF-GRADED-PRICE-PROJECTION — Leo De Vries (modern thin coverage)", () => {
  const pricing = makeLeoPricing();

  it("BASE TARGET — PSA 10 ≈ baseRawMed × 2.560 from tier-1 card-specific ratio", () => {
    const out = computeGradedProjection({ pricing });
    expectAllFmvNull(out);

    const psa10 = byGrade(out, "PSA 10");
    expect(psa10.confidenceTier).toBe("estimate");
    expect(psa10.ratioSource).toBe("card");
    expect(psa10.anchorKind).toBe("base");
    // baseRawMed should be ≈ $228.93 per the fixture
    expect(psa10.diagnostics.baseRawMedian).toBeCloseTo(228.93, 1);
    // Card-specific PSA 10 base median should be 586 (9 base records, median)
    expect(psa10.diagnostics.cardSpecificBaseSamples).toBe(9);
    expect(psa10.diagnostics.targetGradeBaseMedian).toBeCloseTo(586, 1);
    // Implied ratio ≈ 2.560
    expect(psa10.diagnostics.ratio!).toBeCloseTo(2.560, 2);
    // Point estimate ≈ 228.93 × 2.560 ≈ $586
    expect(psa10.estimatedValue!).toBeGreaterThan(550);
    expect(psa10.estimatedValue!).toBeLessThan(620);
    // ±10% band
    expect(psa10.estimateLow!).toBeCloseTo(psa10.estimatedValue! * 0.9, 1);
    expect(psa10.estimateHigh!).toBeCloseTo(psa10.estimatedValue! * 1.1, 1);
  });

  it("BASE TARGET — PSA 9 ≈ baseRawMed × 0.961 (close-to-parity tier-1)", () => {
    const out = computeGradedProjection({ pricing });
    const psa9 = byGrade(out, "PSA 9");
    expect(psa9.confidenceTier).toBe("estimate");
    expect(psa9.ratioSource).toBe("card");
    expect(psa9.diagnostics.cardSpecificBaseSamples).toBe(11);
    expect(psa9.diagnostics.targetGradeBaseMedian).toBeCloseTo(220.05, 1);
    expect(psa9.diagnostics.ratio!).toBeCloseTo(0.961, 2);
    expect(psa9.estimatedValue!).toBeCloseTo(228.93 * 0.961, 0);
  });

  it("BASE TARGET — BGS 9.5 + SGC 10 fall through to tier-3 market premium (ballpark)", () => {
    const out = computeGradedProjection({ pricing });

    const bgs95 = byGrade(out, "BGS 9.5");
    expect(bgs95.confidenceTier).toBe("ballpark");
    expect(bgs95.ratioSource).toBe("market");
    expect(bgs95.anchorKind).toBe("base");
    expect(bgs95.diagnostics.cardSpecificBaseSamples).toBe(0);
    // BGS 9.5 market premium = 3.5x per GRADER_PREMIUMS
    expect(bgs95.diagnostics.ratio).toBe(3.5);
    expect(bgs95.estimatedValue!).toBeCloseTo(228.93 * 3.5, 1);
    // ±30% band on ballpark
    expect(bgs95.estimateLow!).toBeCloseTo(bgs95.estimatedValue! * 0.7, 1);
    expect(bgs95.estimateHigh!).toBeCloseTo(bgs95.estimatedValue! * 1.3, 1);

    const sgc10 = byGrade(out, "SGC 10");
    expect(sgc10.confidenceTier).toBe("ballpark");
    expect(sgc10.ratioSource).toBe("market");
    expect(sgc10.diagnostics.ratio).toBe(3.4); // SGC 10 market premium
    expect(sgc10.estimatedValue!).toBeCloseTo(228.93 * 3.4, 1);
  });

  it("BASE TARGET — PSA 10 base ratio EXCLUDES the $1,299.99 parallel record", () => {
    const out = computeGradedProjection({ pricing });
    const psa10 = byGrade(out, "PSA 10");
    // If the parallel had been included, n_base would be 10 and median would
    // shift toward $613ish. The base-only filter must hold the median at 586.
    expect(psa10.diagnostics.cardSpecificBaseSamples).toBe(9);
    expect(psa10.diagnostics.targetGradeBaseMedian).toBeCloseTo(586, 1);
  });

  it("PARALLEL TARGET (Blue /150, observed anchor $1,183) — PSA 10 = $1,183 × base ratio (2.56), confidenceTier='rough'", () => {
    const out = computeGradedProjection({
      pricing,
      targetParallelId: "0383bf13-523d-407d-b69e-53d33c2a775f",
      targetParallelRawFmv: 1183,
      targetParallelName: "Blue Refractor",
    });
    expectAllFmvNull(out);

    const psa10 = byGrade(out, "PSA 10");
    expect(psa10.confidenceTier).toBe("rough");
    expect(psa10.ratioSource).toBe("card"); // ratio still borrowed from base
    expect(psa10.anchorKind).toBe("parallel-observed");
    expect(psa10.diagnostics.anchorPrice).toBe(1183);
    expect(psa10.diagnostics.ratio!).toBeCloseTo(2.560, 2);
    expect(psa10.estimatedValue!).toBeCloseTo(1183 * 2.560, 0);
    // Basis names the single-sale anchor + base-premium borrow
    expect(psa10.basis).toContain("parallel raw anchor");
    expect(psa10.basis).toContain("base graded comps");
    // ±20% rough band
    expect(psa10.estimateLow!).toBeCloseTo(psa10.estimatedValue! * 0.8, 1);
    expect(psa10.estimateHigh!).toBeCloseTo(psa10.estimatedValue! * 1.2, 1);
  });
});

describe("CF-GRADED-PRICE-PROJECTION — Trout (liquid coverage + dup-bucket quirk)", () => {
  const pricing = makeTroutPricing();

  it("BASE TARGET — full liquid set hits tier-1 except SGC 10 (below threshold)", () => {
    const out = computeGradedProjection({ pricing });
    expectAllFmvNull(out);
    expect(out.length).toBe(TARGET_GRADES.length);

    const psa10 = byGrade(out, "PSA 10");
    expect(psa10.confidenceTier).toBe("estimate");
    expect(psa10.ratioSource).toBe("card");
    expect(psa10.diagnostics.targetGradeBaseMedian).toBeCloseTo(1003.5, 1);

    const psa9 = byGrade(out, "PSA 9");
    expect(psa9.confidenceTier).toBe("estimate");
    expect(psa9.ratioSource).toBe("card");

    const bgs95 = byGrade(out, "BGS 9.5");
    expect(bgs95.confidenceTier).toBe("estimate");
    expect(bgs95.ratioSource).toBe("card");
    expect(bgs95.diagnostics.targetGradeBaseMedian).toBeCloseTo(625, 1);

    // SGC 10 — only 2 base records → tier-1 misses → market fallback
    const sgc10 = byGrade(out, "SGC 10");
    expect(sgc10.confidenceTier).toBe("ballpark");
    expect(sgc10.ratioSource).toBe("market");
    expect(sgc10.diagnostics.cardSpecificBaseSamples).toBe(2);
  });

  it("PSA 9 DUP-BUCKET MERGE — both grades[] entries fold into a single n=8 base pool", () => {
    const out = computeGradedProjection({ pricing });
    const psa9 = byGrade(out, "PSA 9");
    // BucketA = 5 + BucketB = 3 → merged should be 8 base records.
    expect(psa9.diagnostics.cardSpecificBaseSamples).toBe(8);
    // Concatenated median sanity: [388, 379.99, 389.99, 399.99, 405, 409.99, 412, 419.99]
    // → sorted: 379.99, 388, 389.99, 399.99, 405, 409.99, 412, 419.99
    // → median of 8 = (399.99 + 405) / 2 ≈ 402.495
    expect(psa9.diagnostics.targetGradeBaseMedian!).toBeGreaterThan(390);
    expect(psa9.diagnostics.targetGradeBaseMedian!).toBeLessThan(420);
  });

  it("BASE ANCHOR — parallel records are excluded from baseRawMedian", () => {
    const out = computeGradedProjection({ pricing });
    const any = out[0];
    // Fixture has 13 base raw + 2 parallel raw. Base count must be 13.
    expect(any.diagnostics.baseRawSampleCount).toBe(13);
    expect(any.diagnostics.baseRawMedian).toBeCloseTo(299.995, 2);
  });
});

describe("CF-GRADED-PRICE-PROJECTION — display-not-train discipline", () => {
  it("EVERY result on EVERY card carries marketValue=null AND fairMarketValue=null", () => {
    for (const pricing of [makeLeoPricing(), makeTroutPricing()]) {
      const baseOut = computeGradedProjection({ pricing });
      const parallelOut = computeGradedProjection({
        pricing,
        targetParallelId: "test-parallel",
        targetParallelRawFmv: 500,
      });
      expectAllFmvNull(baseOut);
      expectAllFmvNull(parallelOut);
      for (const r of [...baseOut, ...parallelOut]) {
        expect(r.isEstimate).toBe(true);
      }
    }
  });

  it("EVERY result has a basis string naming the anchor + ratio source", () => {
    const pricing = makeLeoPricing();
    const out = computeGradedProjection({ pricing });
    for (const r of out) {
      expect(typeof r.basis).toBe("string");
      expect(r.basis.length).toBeGreaterThan(20);
      expect(r.basis).toMatch(/[Aa]nchor.*[Rr]atio/);
    }
  });
});

describe("CF-GRADED-PRICE-PROJECTION — insufficient-data edge cases", () => {
  it("empty pricing → all results are insufficient", () => {
    const empty: CardsightPricingResponse = {
      card: { card_id: "x", name: "x", number: "x" } as any,
      raw: { count: 0, records: [] },
      graded: [],
      meta: { total_records: 0, last_sale_date: null },
    } as CardsightPricingResponse;
    const out = computeGradedProjection({ pricing: empty });
    for (const r of out) {
      expect(r.confidenceTier).toBe("insufficient");
      expect(r.anchorKind).toBe("none");
      expect(r.estimatedValue).toBeNull();
      expect(r.estimateLow).toBeNull();
      expect(r.estimateHigh).toBeNull();
    }
  });
});

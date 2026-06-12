// CF-GRADED-PRICE-PROJECTION (2026-06-12) — Phase 1a unit coverage for
// computeGradedProjection. Fixtures mirror the Phase 0 recon medians for
// Leo De Vries (modern thin coverage) and Mike Trout 2011 Topps Update
// (liquid coverage with Cardsight's duplicate-grade-bucket quirk).

import { describe, it, expect } from "vitest";
import {
  computeGradedProjection,
  buildGradedEstimates,
  aggregateReleaseGradeCurveFromPricings,
  TARGET_GRADES,
  type GradedProjectionResult,
  type ReleaseGradeCurve,
} from "../src/services/compiq/gradedPriceProjection.js";
import { selectSalesByGrade } from "../src/services/compiq/compiqEstimate.service.js";
import { isBaseTitle } from "../src/services/compiq/parallelTitleMatch.js";
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

// Strip the synthetic $1,299.99 PSA 10 Blue Refractor record from the
// Leo fixture so the parallel test can exercise the "PSA 10 emit" branch.
// (With the GUARD active, leaving the record in skips PSA 10 entirely —
// a separate assertion below confirms that behavior.)
function makeLeoParallelPricingNoBlueGraded(): CardsightPricingResponse {
  const fixture = makeLeoPricing();
  const newGraded = (fixture.graded ?? []).map((co) => {
    if (co.company_name !== "PSA") return co;
    return {
      ...co,
      grades: (co.grades ?? []).map((g) => {
        if (Number(g.grade_value) !== 10) return g;
        return {
          ...g,
          records: (g.records ?? []).filter((r) => r.price !== 1299.99),
        };
      }),
    };
  });
  return { ...fixture, graded: newGraded };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("CF-GRADED-PRICE-PROJECTION — Leo De Vries BASE target (GUARD + gap-fill)", () => {
  it("GUARD — PSA 10 + PSA 9 SKIPPED entirely (have ≥1 observed base sale)", () => {
    const out = computeGradedProjection({ pricing: makeLeoPricing() });
    expectAllFmvNull(out);
    const grades = new Set(out.map((r) => r.grade));
    expect(grades.has("PSA 10")).toBe(false);
    expect(grades.has("PSA 9")).toBe(false);
    // Output should contain only the gap grades.
    expect(out.length).toBe(2);
  });

  it("BGS 9.5 + SGC 10 EMITTED via tier-3 market premium (ballpark)", () => {
    const out = computeGradedProjection({ pricing: makeLeoPricing() });

    const bgs95 = byGrade(out, "BGS 9.5");
    expect(bgs95.confidenceTier).toBe("ballpark");
    expect(bgs95.ratioSource).toBe("market");
    expect(bgs95.anchorKind).toBe("base");
    expect(bgs95.diagnostics.cardSpecificBaseSamples).toBe(0);
    // BGS 9.5 market premium = 3.5× per GRADER_PREMIUMS
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

  it("BASE RAW ANCHOR — diagnostics confirm the 6 parallel raw records are excluded (n=24, not 30)", () => {
    // The fixture has 30 raw records (24 base + 6 parallel). The base
    // anchor must be computed from the 24 base records ONLY. This was the
    // pre-GUARD assertion for "PSA 10 base ratio excludes the parallel
    // record" — now expressed against an emitted grade's diagnostic.
    const out = computeGradedProjection({ pricing: makeLeoPricing() });
    expect(out.length).toBeGreaterThan(0);
    for (const r of out) {
      expect(r.diagnostics.baseRawSampleCount).toBe(24);
      expect(r.diagnostics.baseRawMedian).toBeCloseTo(228.93, 1);
    }
  });
});

describe("CF-GRADED-PRICE-PROJECTION — Leo Blue /150 PARALLEL target", () => {
  const BLUE_PID = "0383bf13-523d-407d-b69e-53d33c2a775f";

  it("PSA 10 EMITTED as rough ($1,183 × card ratio 2.560), basis names parallel-observed anchor", () => {
    // Use the pricing fixture WITHOUT the synthetic $1,299.99 Blue
    // Refractor PSA 10 record, mirroring Leo's production state
    // (Cardsight has 0 graded Blue Refractor records for him).
    const out = computeGradedProjection({
      pricing: makeLeoParallelPricingNoBlueGraded(),
      targetParallelId: BLUE_PID,
      targetParallelRawFmv: 1183,
      targetParallelName: "Blue Refractor",
    });
    expectAllFmvNull(out);

    const psa10 = byGrade(out, "PSA 10");
    expect(psa10.confidenceTier).toBe("rough");
    expect(psa10.ratioSource).toBe("card"); // borrowed from base
    expect(psa10.anchorKind).toBe("parallel-observed");
    expect(psa10.diagnostics.anchorPrice).toBe(1183);
    expect(psa10.diagnostics.ratio!).toBeCloseTo(2.560, 2);
    expect(psa10.estimatedValue!).toBeCloseTo(1183 * 2.560, 0);
    expect(psa10.basis).toContain("parallel raw anchor");
    expect(psa10.basis).toContain("base graded comps");
    // ±20% band on rough
    expect(psa10.estimateLow!).toBeCloseTo(psa10.estimatedValue! * 0.8, 1);
    expect(psa10.estimateHigh!).toBeCloseTo(psa10.estimatedValue! * 1.2, 1);
  });

  it("GUARD on PARALLEL scope — $1,299.99 Blue Refractor PSA 10 record IS observed → PSA 10 SKIPPED", () => {
    // ORIGINAL fixture with the $1,299.99 record present. Title contains
    // "Blue Refractor" tokens, so the parallel-scope guard sees it as
    // observed → PSA 10 must NOT be emitted.
    const out = computeGradedProjection({
      pricing: makeLeoPricing(),
      targetParallelId: BLUE_PID,
      targetParallelRawFmv: 1183,
      targetParallelName: "Blue Refractor",
    });
    const grades = new Set(out.map((r) => r.grade));
    expect(grades.has("PSA 10")).toBe(false);
    // The other grades have zero parallel-scope observed records → emitted.
    expect(grades.has("PSA 9")).toBe(true);
    expect(grades.has("BGS 9.5")).toBe(true);
    expect(grades.has("SGC 10")).toBe(true);
  });
});

describe("CF-GRADED-PRICE-PROJECTION — Trout (full coverage proof)", () => {
  it("EVERY target grade has observed base sales → ZERO estimates emitted", () => {
    // Trout's fixture covers PSA 10 + PSA 9 + BGS 9.5 + SGC 10 with
    // observed base records (PSA 10 n=11, PSA 9 dup-bucket n=8, BGS 9.5
    // n=7, SGC 10 n=2 — all ≥1, all GUARD-triggering). The estimator
    // must return zero results: it fills gaps, never overlays observed.
    const out = computeGradedProjection({ pricing: makeTroutPricing() });
    expect(out).toEqual([]);
  });
});

describe("CF-GRADED-PRICE-PROJECTION — display-not-train discipline", () => {
  it("EVERY emitted result on EVERY card carries marketValue=null AND fairMarketValue=null", () => {
    for (const pricing of [makeLeoPricing(), makeTroutPricing()]) {
      const baseOut = computeGradedProjection({ pricing });
      const parallelOut = computeGradedProjection({
        pricing,
        targetParallelId: "test-parallel",
        targetParallelRawFmv: 500,
        targetParallelName: "Some Parallel",
      });
      expectAllFmvNull(baseOut);
      expectAllFmvNull(parallelOut);
      for (const r of [...baseOut, ...parallelOut]) {
        expect(r.isEstimate).toBe(true);
      }
    }
  });

  it("EVERY emitted result has a basis string naming anchor + ratio", () => {
    const pricing = makeLeoPricing();
    const out = computeGradedProjection({ pricing });
    expect(out.length).toBeGreaterThan(0);
    for (const r of out) {
      expect(typeof r.basis).toBe("string");
      expect(r.basis.length).toBeGreaterThan(20);
      expect(r.basis).toMatch(/[Aa]nchor.*[Rr]atio/);
    }
  });
});

describe("CF-GRADED-PRICE-PROJECTION — FMV regression (the proof)", () => {
  // The invariant: the estimator's presence never moves a single
  // observed number. Operationally, this means every grade that
  // appears in the estimator output is GUARANTEED to carry zero
  // observed comps in the requested scope — proof that the GUARD
  // truly prevents overlay. When Phase 1b wires the estimator into
  // the response, this property survives.

  it("BASE scope INVARIANT — every emitted grade has zero base observed records (any fixture)", () => {
    // Use the imports the engine itself uses, so the test is a direct
    // mirror of the GUARD's own definition of "observed".
    for (const pricing of [makeLeoPricing(), makeTroutPricing()]) {
      const out = computeGradedProjection({ pricing });
      for (const r of out) {
        const records = selectSalesByGrade(pricing, r.grade);
        const baseN = records.filter(
          (rec: CardsightSaleRecord) =>
            rec.parallel_id == null && isBaseTitle(rec.title),
        ).length;
        expect(
          baseN,
          `${r.grade} emitted estimate while ${baseN} base observed records exist`,
        ).toBe(0);
      }
    }
  });

  it("PARALLEL scope INVARIANT — every emitted grade has zero parallel-scope observed records", () => {
    const BLUE_PID = "0383bf13-523d-407d-b69e-53d33c2a775f";

    const pricing = makeLeoPricing();
    const out = computeGradedProjection({
      pricing,
      targetParallelId: BLUE_PID,
      targetParallelRawFmv: 1183,
      targetParallelName: "Blue Refractor",
    });
    for (const r of out) {
      const records = selectSalesByGrade(pricing, r.grade) as CardsightSaleRecord[];
      // Strict tag
      const strict = records.filter((rec) => rec.parallel_id === BLUE_PID).length;
      // Title-token fallback (matches engine's GUARD logic)
      const titleMatch = records.filter((rec) => {
        const t = String(rec.title ?? "").toLowerCase();
        return /\bblue\b/.test(t) && /\brefractor\b/.test(t);
      }).length;
      const parallelObserved = strict > 0 ? strict : titleMatch;
      expect(
        parallelObserved,
        `${r.grade} emitted estimate while ${parallelObserved} parallel-scope observed records exist`,
      ).toBe(0);
    }
  });
});

describe("CF-GRADED-PRICE-PROJECTION — TIER 2 (player/set sibling aggregation)", () => {
  // Sibling-aggregation fixtures: mimic CompByPlayer shape that the live
  // path's fetchSiblingSales → fetchCompsByPlayer would emit. Each
  // entry carries title + price (parallel_id absent — the realistic
  // input shape on the live path; tier-2 falls back to title-only base
  // detection, slightly less strict than tier-1's record-level check).
  function makeSiblingComps(opts: {
    nBgs95Base: number;
    nRawBase: number;
    nBgs95Parallel?: number;
    bgs95Price?: number;
    rawPrice?: number;
  }) {
    const comps: Array<{
      title: string;
      price: number;
      parallel_id?: string | null;
    }> = [];
    for (let i = 0; i < opts.nBgs95Base; i++) {
      comps.push({
        title: `2024 Bowman Chrome Brendan Birdsong #CPA-BB base sibling ${i} BGS 9.5`,
        price: (opts.bgs95Price ?? 800) + i * 5,
      });
    }
    for (let i = 0; i < opts.nRawBase; i++) {
      comps.push({
        title: `2024 Bowman Chrome Brendan Birdsong #CPA-BB sibling raw ${i}`,
        price: (opts.rawPrice ?? 250) + i * 5,
      });
    }
    for (let i = 0; i < (opts.nBgs95Parallel ?? 0); i++) {
      // Parallel sibling — must be EXCLUDED from tier-2 base detection
      comps.push({
        title: `2024 Bowman Chrome Brendan Birdsong #CPA-BB Blue Refractor /150 sibling ${i} BGS 9.5`,
        price: 2500,
      });
    }
    return comps;
  }

  it("Leo BGS 9.5 — siblings supply ≥5 base BGS 9.5 → tier-2 emit ('rough' / 'player-set')", () => {
    const pricing = makeLeoPricing();
    const siblingComps = makeSiblingComps({ nBgs95Base: 6, nRawBase: 8 });
    const out = computeGradedProjection({ pricing, siblingComps });
    expectAllFmvNull(out);

    const bgs95 = byGrade(out, "BGS 9.5");
    expect(bgs95.confidenceTier).toBe("rough");
    expect(bgs95.ratioSource).toBe("player-set");
    expect(bgs95.anchorKind).toBe("base");
    // Ratio = sibling base BGS 9.5 median / sibling base raw median.
    // Sibling BGS 9.5 prices: 800..825 → median 812.5
    // Sibling raw     prices: 250..285 → median 267.5
    // Ratio ≈ 812.5 / 267.5 ≈ 3.037×
    expect(bgs95.diagnostics.ratio!).toBeCloseTo(3.037, 1);
    // Anchor remains the card's own base raw median ($228.93) — the
    // sibling raw is the tier-2 DENOMINATOR, not the anchor.
    expect(bgs95.diagnostics.anchorPrice).toBeCloseTo(228.93, 1);
    expect(bgs95.estimatedValue!).toBeCloseTo(228.93 * (812.5 / 267.5), 0);
    expect(bgs95.basis).toContain("sibling cards");
    expect(bgs95.basis).toContain("6 base BGS 9.5");
    // ±20% rough band
    expect(bgs95.estimateLow!).toBeCloseTo(bgs95.estimatedValue! * 0.8, 1);
    expect(bgs95.estimateHigh!).toBeCloseTo(bgs95.estimatedValue! * 1.2, 1);
  });

  it("Leo BGS 9.5 — siblings thin (<5 base BGS 9.5) → tier-3 market fallback (ballpark)", () => {
    const pricing = makeLeoPricing();
    const siblingComps = makeSiblingComps({ nBgs95Base: 4, nRawBase: 8 });
    const out = computeGradedProjection({ pricing, siblingComps });

    const bgs95 = byGrade(out, "BGS 9.5");
    expect(bgs95.confidenceTier).toBe("ballpark");
    expect(bgs95.ratioSource).toBe("market");
    expect(bgs95.diagnostics.ratio).toBe(3.5);
    expect(bgs95.estimatedValue!).toBeCloseTo(228.93 * 3.5, 1);
  });

  it("Tier 2 — sibling PARALLEL records are excluded from the tier-2 base aggregation", () => {
    // 4 base BGS 9.5 siblings (below threshold) + 4 PARALLEL BGS 9.5 siblings.
    // Tier 2 sees only the 4 base → below threshold → falls to tier 3.
    const pricing = makeLeoPricing();
    const siblingComps = makeSiblingComps({
      nBgs95Base: 4,
      nBgs95Parallel: 4,
      nRawBase: 8,
    });
    const out = computeGradedProjection({ pricing, siblingComps });
    const bgs95 = byGrade(out, "BGS 9.5");
    expect(bgs95.ratioSource).toBe("market");
  });

  it("Tier 2 — siblingComps empty (default) → tier-1 miss → tier-3 fallback (existing behavior preserved)", () => {
    const out = computeGradedProjection({ pricing: makeLeoPricing() });
    const bgs95 = byGrade(out, "BGS 9.5");
    expect(bgs95.confidenceTier).toBe("ballpark");
    expect(bgs95.ratioSource).toBe("market");
  });

  it("Tier 2 — sibling raw denominator missing → tier-3 fallback (can't anchor the ratio)", () => {
    // 6 BGS 9.5 base siblings (above threshold) but ZERO base raw siblings.
    // Tier 2 needs both numerator AND denominator; falls through to tier 3.
    const pricing = makeLeoPricing();
    const siblingComps = makeSiblingComps({ nBgs95Base: 6, nRawBase: 0 });
    const out = computeGradedProjection({ pricing, siblingComps });
    const bgs95 = byGrade(out, "BGS 9.5");
    expect(bgs95.ratioSource).toBe("market");
  });

  it("Tier 2 — confidenceTier stays 'rough' even when card-anchor is parallel-observed", () => {
    const pricing = makeLeoParallelPricingNoBlueGraded();
    const siblingComps = makeSiblingComps({ nBgs95Base: 6, nRawBase: 8 });
    const out = computeGradedProjection({
      pricing,
      targetParallelId: "0383bf13-523d-407d-b69e-53d33c2a775f",
      targetParallelRawFmv: 1183,
      targetParallelName: "Blue Refractor",
      siblingComps,
    });
    const bgs95 = byGrade(out, "BGS 9.5");
    expect(bgs95.confidenceTier).toBe("rough");
    expect(bgs95.ratioSource).toBe("player-set");
    expect(bgs95.anchorKind).toBe("parallel-observed");
    expect(bgs95.diagnostics.anchorPrice).toBe(1183);
    expect(bgs95.estimatedValue!).toBeCloseTo(1183 * (812.5 / 267.5), 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CF-GRADED-PRICE-PROJECTION Phase 2 — buildGradedEstimates wiring
// ─────────────────────────────────────────────────────────────────────────
// Live-path integration coverage for the wrapper that the /price-by-id
// route calls. Proves:
//   1. Grounded-only filter (ratioSource ∈ {card, player-set} survive;
//      ratioSource="market" + "none" dropped → "gaps honest").
//   2. No-mutation invariant on pricing payload + marketTier.value +
//      recentComps + gradeBreakdown (the structural firewall — graded
//      estimates can't touch a single observed number).
//   3. FMV-null on every emitted entry (display-not-train discipline).

describe("CF-GRADED-PRICE-PROJECTION Phase 2 — buildGradedEstimates wiring", () => {
  it("Leo Blue /150 → emits PSA 10 + PSA 9 rough; drops BGS 9.5 + SGC 10 ballpark", () => {
    // Mirror the live /price-by-id call shape: pricing + parallel scope +
    // observed parallel raw FMV. iOS asks for the Blue /150 parallel raw
    // FMV; the engine borrows the base card ratio for PSA 10/9 because
    // the parallel itself has zero graded comps.
    const pricing = makeLeoParallelPricingNoBlueGraded();
    const fmv = 1183; // est.fairMarketValue for the parallel-scope request
    const recentCompsSnap = [{ price: 1183, date: "2026-06-09" }];
    const gradeBreakdownSnap = [{ grade: "PSA 10", n: 9, median: 586 }];

    const { estimates, mutationDetected } = buildGradedEstimates({
      pricing,
      targetParallelId: "0383bf13-523d-407d-b69e-53d33c2a775f",
      targetParallelName: "Blue Refractor",
      targetParallelRawFmv: fmv,
      snapshots: {
        marketTierValue: fmv,
        recentComps: recentCompsSnap,
        gradeBreakdown: gradeBreakdownSnap,
      },
    });

    expect(mutationDetected).toBe(false);
    // GROUNDED-ONLY: PSA 10 + PSA 9 (card-ratio rough) survive; BGS 9.5 +
    // SGC 10 (tier-3 market ballpark) are dropped.
    const grades = estimates.map((e) => e.grade).sort();
    expect(grades).toEqual(["PSA 10", "PSA 9"]);

    const psa10 = estimates.find((e) => e.grade === "PSA 10")!;
    expect(psa10.confidenceTier).toBe("rough");
    expect(psa10.ratioSource).toBe("card");
    expect(psa10.anchorKind).toBe("parallel-observed");
    expect(psa10.diagnostics.anchorPrice).toBe(1183);
    expect(psa10.estimatedValue!).toBeCloseTo(1183 * 2.560, 0);
    expect(psa10.fairMarketValue).toBeNull();
    expect(psa10.marketValue).toBeNull();
    expect(psa10.isEstimate).toBe(true);

    const psa9 = estimates.find((e) => e.grade === "PSA 9")!;
    expect(psa9.confidenceTier).toBe("rough");
    expect(psa9.ratioSource).toBe("card");
    expect(psa9.fairMarketValue).toBeNull();

    // Every emitted entry FMV-null (display-not-train invariant).
    for (const e of estimates) {
      expect(e.fairMarketValue).toBeNull();
      expect(e.marketValue).toBeNull();
      expect(e.isEstimate).toBe(true);
    }
  });

  it("Leo BASE → emits nothing (PSA 10/9 observed; BGS 9.5/SGC 10 are tier-3 ballpark, dropped)", () => {
    // BASE-scope call (no parallel passthrough). GUARD skips PSA 10/9
    // (observed). BGS 9.5 + SGC 10 only have tier-3 market premium →
    // grounded filter drops them. Result: empty.
    const pricing = makeLeoPricing();
    const fmv = 228.93;
    const { estimates, mutationDetected } = buildGradedEstimates({
      pricing,
      snapshots: {
        marketTierValue: fmv,
        recentComps: [{ price: 250, date: "2026-06-08" }],
        gradeBreakdown: [{ grade: "PSA 10", n: 9 }],
      },
    });

    expect(mutationDetected).toBe(false);
    expect(estimates).toEqual([]);
  });

  it("Trout → emits nothing (full coverage; every grade observed → engine returns [])", () => {
    // Trout BASE: every liquid grade has observed base sales → GUARD
    // skips all four → engine returns []. Filter is a no-op; estimates [].
    const pricing = makeTroutPricing();
    const fmv = 299.995;
    const { estimates, mutationDetected } = buildGradedEstimates({
      pricing,
      snapshots: {
        marketTierValue: fmv,
        recentComps: [{ price: 300, date: "2026-06-09" }],
        gradeBreakdown: [
          { grade: "PSA 10", n: 11 },
          { grade: "PSA 9", n: 8 },
          { grade: "BGS 9.5", n: 7 },
          { grade: "SGC 10", n: 2 },
        ],
      },
    });

    expect(mutationDetected).toBe(false);
    expect(estimates).toEqual([]);
  });

  it("NO-MUTATION INVARIANT — pricing JSON byte-identical across the engine call (all three fixtures)", () => {
    // Strongest assertion: serialize pricing before AND after the call,
    // demand byte-equal. Proves the engine never mutates the shared
    // pricing payload — the structural firewall that protects training
    // joins from estimator side-effects.
    for (const make of [makeLeoPricing, makeLeoParallelPricingNoBlueGraded, makeTroutPricing]) {
      const pricing = make();
      const beforeJson = JSON.stringify(pricing);
      const recentCompsRef: unknown[] = [{ price: 100 }];
      const recentCompsBefore = JSON.stringify(recentCompsRef);
      const gradeBreakdownRef: unknown[] = [{ grade: "PSA 10", n: 1 }];
      const gradeBreakdownBefore = JSON.stringify(gradeBreakdownRef);

      const { mutationDetected } = buildGradedEstimates({
        pricing,
        targetParallelId: make === makeLeoParallelPricingNoBlueGraded
          ? "0383bf13-523d-407d-b69e-53d33c2a775f"
          : null,
        targetParallelName: make === makeLeoParallelPricingNoBlueGraded
          ? "Blue Refractor"
          : null,
        targetParallelRawFmv: make === makeLeoParallelPricingNoBlueGraded ? 1183 : null,
        snapshots: {
          marketTierValue: 228.93,
          recentComps: recentCompsRef,
          gradeBreakdown: gradeBreakdownRef,
        },
      });

      expect(mutationDetected).toBe(false);
      // Independent post-hoc check (defense in depth — don't trust the
      // helper to police itself):
      expect(JSON.stringify(pricing)).toBe(beforeJson);
      expect(JSON.stringify(recentCompsRef)).toBe(recentCompsBefore);
      expect(JSON.stringify(gradeBreakdownRef)).toBe(gradeBreakdownBefore);
    }
  });

});

// ─────────────────────────────────────────────────────────────────────────
// CF-GRADED-PRICE-PROJECTION Phase 1c — release-level grade-premium curve
// ─────────────────────────────────────────────────────────────────────────
// Tests aggregateReleaseGradeCurveFromPricings (the pure aggregation that
// the live computeReleaseGradeCurve calls after searchCatalog + harvest)
// AND the resolveRatio tier-2b wiring that consumes the curve.
//
// The curve is the MEDIAN of PER-CARD raw→graded ratios — value-normalized
// so an expensive auto in the release doesn't dominate the curve when a
// dozen commons would otherwise outweigh it.

describe("CF-GRADED-PRICE-PROJECTION Phase 1c — release-level grade-premium curve", () => {
  /** Fixture: tiny synthetic "release" — 4 cards with varying coverage.
   *  Card A: base raw $100, PSA 10 base $400, BGS 9.5 base $350 → PSA10=4.0, BGS95=3.5
   *  Card B: base raw $200, PSA 10 base $700, BGS 9.5 base $600 → PSA10=3.5, BGS95=3.0
   *  Card C: base raw $50,  PSA 10 base $250                    → PSA10=5.0
   *  Card D: base raw $300, SGC 10 base $720                    → SGC10=2.4 (only this card has SGC 10)
   *  Expected curve:
   *    PSA 10:  median([4.0, 3.5, 5.0]) = 4.0, n=3 (PASS threshold)
   *    BGS 9.5: median([3.5, 3.0])      = 3.25, n=2 (FAIL threshold — <3)
   *    SGC 10:  median([2.4])           = 2.4, n=1 (FAIL threshold — <3)
   *    PSA 9: no contributing cards (none have it) — absent from curve */
  function makeReleaseFixturePricings(): CardsightPricingResponse[] {
    const rawPrices = [100, 200, 50, 300];
    const psa10Prices: Array<number | null> = [400, 700, 250, null];
    const bgs95Prices: Array<number | null> = [350, 600, null, null];
    const sgc10Prices: Array<number | null> = [null, null, null, 720];
    const out: CardsightPricingResponse[] = [];
    for (let i = 0; i < 4; i++) {
      // Build 3 base raw records around the median so n>=3 → tier-1 anchor.
      const r = rawPrices[i]!;
      const baseRaw: CardsightSaleRecord[] = [
        rec(`Release Card ${i} base raw a`, r - 5),
        rec(`Release Card ${i} base raw b`, r),
        rec(`Release Card ${i} base raw c`, r + 5),
      ];
      const gradedCompanies: Array<{
        company_name: string;
        grades: Array<{ grade_value: number | string; count: number; records: CardsightSaleRecord[] }>;
      }> = [];
      const psa10 = psa10Prices[i];
      if (psa10 != null) {
        const recs: CardsightSaleRecord[] = [
          rec(`Release Card ${i} PSA 10 base a`, psa10 - 10),
          rec(`Release Card ${i} PSA 10 base b`, psa10),
          rec(`Release Card ${i} PSA 10 base c`, psa10 + 10),
        ];
        gradedCompanies.push({
          company_name: "PSA",
          grades: [gradedBucket(10, recs)],
        });
      }
      const bgs95 = bgs95Prices[i];
      if (bgs95 != null) {
        const recs: CardsightSaleRecord[] = [
          rec(`Release Card ${i} BGS 9.5 base a`, bgs95 - 10),
          rec(`Release Card ${i} BGS 9.5 base b`, bgs95),
          rec(`Release Card ${i} BGS 9.5 base c`, bgs95 + 10),
        ];
        gradedCompanies.push({
          company_name: "BGS",
          grades: [gradedBucket(9.5, recs)],
        });
      }
      const sgc10 = sgc10Prices[i];
      if (sgc10 != null) {
        const recs: CardsightSaleRecord[] = [
          rec(`Release Card ${i} SGC 10 base a`, sgc10 - 10),
          rec(`Release Card ${i} SGC 10 base b`, sgc10),
          rec(`Release Card ${i} SGC 10 base c`, sgc10 + 10),
        ];
        gradedCompanies.push({
          company_name: "SGC",
          grades: [gradedBucket(10, recs)],
        });
      }
      out.push({
        card: { card_id: `card-${i}`, name: `Card ${i}` } as any,
        raw: { count: baseRaw.length, records: baseRaw },
        graded: gradedCompanies,
        meta: { total_records: baseRaw.length, last_sale_date: null },
      } as CardsightPricingResponse);
    }
    return out;
  }

  it("aggregateReleaseGradeCurveFromPricings — value-normalized median per-card ratios; threshold gates per grade", () => {
    const pricings = makeReleaseFixturePricings();
    const curve = aggregateReleaseGradeCurveFromPricings(pricings);

    // PSA 10: 3 cards contribute → curve fires
    expect(curve.has("PSA 10")).toBe(true);
    const psa10 = curve.get("PSA 10")!;
    expect(psa10.contributingCards).toBe(3);
    expect(psa10.ratio).toBeCloseTo(4.0, 2); // median([4.0, 3.5, 5.0]) = 4.0

    // BGS 9.5: only 2 cards contribute → BELOW threshold, dropped
    expect(curve.has("BGS 9.5")).toBe(false);

    // SGC 10: only 1 card contributes → BELOW threshold, dropped
    expect(curve.has("SGC 10")).toBe(false);

    // PSA 9: no cards → absent
    expect(curve.has("PSA 9")).toBe(false);
  });

  it("expensive card doesn't dominate — per-card-ratio median ignores price magnitude", () => {
    // Build a release where one $5,000 card has ratio 3.0× and three
    // $50 cards have ratio 6.0×. Pooled (raw-pool / graded-pool) would
    // be dominated by the $5,000 card. Per-card median should be 6.0×.
    const cheap = (cardId: string, ratio: number): CardsightPricingResponse => ({
      card: { card_id: cardId, name: cardId } as any,
      raw: {
        count: 3,
        records: [
          rec(`${cardId} base raw a`, 48),
          rec(`${cardId} base raw b`, 50),
          rec(`${cardId} base raw c`, 52),
        ],
      },
      graded: [{
        company_name: "PSA",
        grades: [gradedBucket(10, [
          rec(`${cardId} PSA 10 base a`, 50 * ratio - 5),
          rec(`${cardId} PSA 10 base b`, 50 * ratio),
          rec(`${cardId} PSA 10 base c`, 50 * ratio + 5),
        ])],
      }],
      meta: { total_records: 6, last_sale_date: null },
    } as CardsightPricingResponse);
    const expensive: CardsightPricingResponse = {
      card: { card_id: "expensive", name: "Expensive" } as any,
      raw: {
        count: 3,
        records: [
          rec("expensive base raw a", 4995),
          rec("expensive base raw b", 5000),
          rec("expensive base raw c", 5005),
        ],
      },
      graded: [{
        company_name: "PSA",
        grades: [gradedBucket(10, [
          rec("expensive PSA 10 base a", 14995),
          rec("expensive PSA 10 base b", 15000),
          rec("expensive PSA 10 base c", 15005),
        ])],
      }],
      meta: { total_records: 6, last_sale_date: null },
    } as CardsightPricingResponse;
    const curve = aggregateReleaseGradeCurveFromPricings([
      cheap("a", 6),
      cheap("b", 6),
      cheap("c", 6),
      expensive,
    ]);
    const psa10 = curve.get("PSA 10")!;
    expect(psa10).toBeDefined();
    expect(psa10.contributingCards).toBe(4);
    // Per-card ratios: [6.0, 6.0, 6.0, 3.0]. Median = (6 + 6) / 2 = 6.0
    // (4 values: 3, 6, 6, 6 sorted → median of middle two = 6).
    expect(psa10.ratio).toBeCloseTo(6.0, 2);
    // Pooled-median check: pooled graded ($300 + $300 + $300 + $15000) median
    // would be $300 vs pooled raw $50, ratio = 6 — happens to match here
    // because the cheap cards dominate count. The KEY assertion is that
    // contributingCards is the per-card vote count, not the record count.
  });

  it("tier-2b wiring — release curve fills a BASE-target gap grade as rough/release", () => {
    // Leo base scope (no parallel). BGS 9.5 has no card-specific base
    // graded comps → tier-1 misses. With a release curve providing
    // BGS 9.5 ratio 3.25×, tier-2b fires; without it, tier-3 ballpark.
    const pricing = makeLeoPricing();
    const curve: ReleaseGradeCurve = new Map([
      ["BGS 9.5", { ratio: 3.25, contributingCards: 7 }],
      ["SGC 10", { ratio: 3.05, contributingCards: 4 }],
    ]);
    const out = computeGradedProjection({
      pricing,
      releaseRatios: curve,
      releaseLabel: "2024 Bowman Chrome Prospects Autographs",
    });
    expectAllFmvNull(out);

    const bgs95 = byGrade(out, "BGS 9.5");
    expect(bgs95.confidenceTier).toBe("rough");
    expect(bgs95.ratioSource).toBe("release");
    expect(bgs95.anchorKind).toBe("base");
    expect(bgs95.diagnostics.ratio).toBeCloseTo(3.25, 2);
    expect(bgs95.estimatedValue!).toBeCloseTo(228.93 * 3.25, 0);
    expect(bgs95.basis).toContain("2024 Bowman Chrome Prospects Autographs");
    expect(bgs95.basis).toContain("7 cards in the release");
    // ±20% rough band
    expect(bgs95.estimateLow!).toBeCloseTo(bgs95.estimatedValue! * 0.8, 1);
    expect(bgs95.estimateHigh!).toBeCloseTo(bgs95.estimatedValue! * 1.2, 1);

    const sgc10 = byGrade(out, "SGC 10");
    expect(sgc10.ratioSource).toBe("release");
    expect(sgc10.confidenceTier).toBe("rough");
  });

  it("tier-2b absent for a grade → tier-3 market fallback (ballpark)", () => {
    // Curve covers BGS 9.5 but NOT SGC 10. SGC 10 must fall through to
    // tier-3 market premium (3.4×).
    const pricing = makeLeoPricing();
    const curve: ReleaseGradeCurve = new Map([
      ["BGS 9.5", { ratio: 3.25, contributingCards: 5 }],
    ]);
    const out = computeGradedProjection({
      pricing,
      releaseRatios: curve,
      releaseLabel: "2024 Bowman Chrome Prospects Autographs",
    });
    const bgs95 = byGrade(out, "BGS 9.5");
    expect(bgs95.ratioSource).toBe("release"); // tier-2b
    const sgc10 = byGrade(out, "SGC 10");
    expect(sgc10.ratioSource).toBe("market");   // tier-3 fallback
    expect(sgc10.confidenceTier).toBe("ballpark");
  });

  it("tier-2b respects tier-1 precedence — never overrides a card-specific ratio", () => {
    // Trout has card-specific base graded for every liquid grade →
    // tier-1 fires on every observed-skip path. The release curve
    // should be irrelevant for any grade where tier-1 anchored. But
    // since the GUARD skips observed grades entirely for Trout, the
    // result is still [] — proves tier ordering at the engine, not
    // the filter, by checking the output is empty even with a curve.
    const pricing = makeTroutPricing();
    const curve: ReleaseGradeCurve = new Map([
      ["PSA 10", { ratio: 99, contributingCards: 9 }],   // wildly wrong on purpose
      ["BGS 9.5", { ratio: 99, contributingCards: 9 }],
      ["SGC 10", { ratio: 99, contributingCards: 9 }],
      ["PSA 9", { ratio: 99, contributingCards: 9 }],
    ]);
    const out = computeGradedProjection({
      pricing,
      releaseRatios: curve,
      releaseLabel: "2011 Topps Update",
    });
    // Every grade has observed sales → GUARD skips all → output empty.
    // If the curve had bled past the GUARD, we'd see ratio=99 entries.
    expect(out).toEqual([]);
  });

  it("tier-2b doesn't override tier-2a — player-set still wins when populated", () => {
    // Phase 1b's player-set tier is no-op in production (no graded
    // sibling source) but still in the engine. When BOTH are present,
    // player-set should win (it's "more specific" — same player vs
    // same release).
    const pricing = makeLeoPricing();
    // 6 base BGS 9.5 sibling comps + 8 base raw sibling comps (Phase
    // 1b's tier-2a threshold).
    const siblingComps = [
      ...Array.from({ length: 6 }, (_, i) => ({
        title: `2024 Bowman Chrome Brendan Birdsong #CPA-BB base sibling ${i} BGS 9.5`,
        price: 800 + i * 5,
      })),
      ...Array.from({ length: 8 }, (_, i) => ({
        title: `2024 Bowman Chrome Brendan Birdsong #CPA-BB sibling raw ${i}`,
        price: 250 + i * 5,
      })),
    ];
    const curve: ReleaseGradeCurve = new Map([
      ["BGS 9.5", { ratio: 99, contributingCards: 99 }], // wildly wrong on purpose
    ]);
    const out = computeGradedProjection({
      pricing,
      siblingComps,
      releaseRatios: curve,
      releaseLabel: "2024 Bowman Chrome Prospects Autographs",
    });
    const bgs95 = byGrade(out, "BGS 9.5");
    expect(bgs95.ratioSource).toBe("player-set"); // tier-2a beats tier-2b
    expect(bgs95.diagnostics.ratio).not.toBeCloseTo(99, 1);
  });

  it("buildGradedEstimates surfaces tier-2b 'rough' — grounded filter accepts ratioSource=release", () => {
    // Integration check: the Phase 2 grounded-only filter must pass
    // "release"-tier results through (they're "rough", not "ballpark").
    const pricing = makeLeoPricing();
    const curve: ReleaseGradeCurve = new Map([
      ["BGS 9.5", { ratio: 3.25, contributingCards: 5 }],
      ["SGC 10", { ratio: 3.05, contributingCards: 4 }],
    ]);
    const { estimates, mutationDetected } = buildGradedEstimates({
      pricing,
      releaseRatios: curve,
      releaseLabel: "2024 Bowman Chrome Prospects Autographs",
      snapshots: {
        marketTierValue: 228.93,
        recentComps: [],
        gradeBreakdown: [],
      },
    });
    expect(mutationDetected).toBe(false);
    const grades = estimates.map((e) => e.grade).sort();
    expect(grades).toEqual(["BGS 9.5", "SGC 10"]);
    for (const e of estimates) {
      expect(e.confidenceTier).toBe("rough");
      expect(e.ratioSource).toBe("release");
      expect(e.fairMarketValue).toBeNull();
    }
  });
});

describe("CF-GRADED-PRICE-PROJECTION — insufficient-data edge cases", () => {
  it("empty pricing → no observed (GUARD doesn't fire) → all results 'insufficient'", () => {
    const empty: CardsightPricingResponse = {
      card: { card_id: "x", name: "x", number: "x" } as any,
      raw: { count: 0, records: [] },
      graded: [],
      meta: { total_records: 0, last_sale_date: null },
    } as CardsightPricingResponse;
    const out = computeGradedProjection({ pricing: empty });
    // GUARD doesn't fire (no observed anywhere), so all 4 grades reach
    // the ratio + emit step. Anchor is null → confidenceTier="insufficient",
    // value/range null. The output is non-empty but every entry is honest
    // "no data" — never a hallucinated number.
    expect(out.length).toBe(TARGET_GRADES.length);
    for (const r of out) {
      expect(r.confidenceTier).toBe("insufficient");
      expect(r.anchorKind).toBe("none");
      expect(r.estimatedValue).toBeNull();
      expect(r.estimateLow).toBeNull();
      expect(r.estimateHigh).toBeNull();
    }
  });
});

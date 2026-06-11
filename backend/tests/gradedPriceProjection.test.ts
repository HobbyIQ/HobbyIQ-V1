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

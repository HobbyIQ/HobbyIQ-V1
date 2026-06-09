/**
 * CF-GRADE-BREAKDOWN (2026-06-09) — buildGradeBreakdown unit tests.
 *
 * Asserts:
 *   - emits one entry per graded bucket with ≥1 sale (after parallel)
 *   - drops buckets that filter to empty (parallel mismatch / no records)
 *   - dedupes duplicate same-grade buckets within a company by Number()
 *   - whole-dollar median; no fabricated direction on thin pools
 *   - sort: PSA, BGS, SGC, CGC, then alphabetical; numeric grade desc
 *   - parallel filter is applied — Trout Gold in PSA 10 isolates 4 records
 */
import { describe, it, expect } from "vitest";
import { buildGradeBreakdown } from "../src/services/compiq/marketRead.service";

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function record(
  price: number,
  daysAgo: number,
  parallel_id?: string,
  parallel_name?: string,
): any {
  const r: any = {
    title: "x",
    price,
    date: isoDaysAgo(daysAgo),
    source: "ebay",
    url: null,
  };
  if (parallel_id) {
    r.parallel_id = parallel_id;
    r.parallel_name = parallel_name ?? "p";
  }
  return r;
}

describe("buildGradeBreakdown", () => {
  it("emits one entry per graded bucket with ≥1 sale (no parallel filter)", () => {
    const pricing: any = {
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "PSA",
          grades: [
            { grade_value: "10", records: [record(1000, 1), record(1100, 3), record(1050, 5)] },
            { grade_value: "9", records: [record(500, 2), record(520, 4)] },
            { grade_value: "8", records: [] }, // empty bucket — dropped
          ],
        },
        {
          company_name: "BGS",
          grades: [
            { grade_value: "9.5", records: [record(1200, 1), record(1250, 6)] },
          ],
        },
      ],
    };
    const out = buildGradeBreakdown(pricing, null);
    expect(out).toHaveLength(3);
    const labels = out.map((e) => `${e.grader} ${e.grade}`);
    // Sort order: PSA then BGS; PSA 10 before PSA 9; BGS 9.5 last
    expect(labels).toEqual(["PSA 10", "PSA 9", "BGS 9.5"]);
    expect(out[0].compCount).toBe(3);
    expect(out[0].median).toBe(1050);
    expect(out[1].compCount).toBe(2);
    expect(out[1].median).toBe(510); // (500+520)/2
  });

  it("dedupes duplicate same-grade buckets (PSA 9 = 117 + 3)", () => {
    const pricing: any = {
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "PSA",
          grades: [
            { grade_value: "9", records: [record(500, 1), record(520, 2), record(510, 3)] },
            { grade_value: "9", records: [record(530, 4), record(540, 5)] }, // duplicate bucket
          ],
        },
      ],
    };
    const out = buildGradeBreakdown(pricing, null);
    expect(out).toHaveLength(1);
    expect(out[0].grader).toBe("PSA");
    expect(out[0].grade).toBe("9");
    expect(out[0].compCount).toBe(5);
    expect(out[0].median).toBe(520); // median of [500, 510, 520, 530, 540]
  });

  it("parallel filter: parallelId given → isolates Gold-tagged records (Trout PSA 10 Gold)", () => {
    const GOLD = "b44f73a5-3100-41d5-8235-047636739e6e";
    const pricing: any = {
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "PSA",
          grades: [
            {
              grade_value: "10",
              records: [
                record(1000, 1),
                record(1100, 3),
                record(1050, 5),
                record(1200, 7),
                record(899, 9, GOLD, "Gold"),
                record(999, 11, GOLD, "Gold"),
                record(1099, 13, GOLD, "Gold"),
                record(899, 15, GOLD, "Gold"),
              ],
            },
          ],
        },
      ],
    };
    const baseOut = buildGradeBreakdown(pricing, null);
    expect(baseOut).toHaveLength(1);
    expect(baseOut[0].compCount).toBe(4); // base = 4 non-tagged
    expect(baseOut[0].median).toBe(1075);

    const goldOut = buildGradeBreakdown(pricing, GOLD);
    expect(goldOut).toHaveLength(1);
    expect(goldOut[0].compCount).toBe(4); // Gold = 4 tagged
    expect(goldOut[0].median).toBe(949); // median of [899, 899, 999, 1099]
  });

  it("parallel mode drops buckets that have no matching records", () => {
    const GOLD = "GOLD";
    const pricing: any = {
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "PSA",
          grades: [
            { grade_value: "10", records: [record(1000, 1, GOLD, "Gold")] },
            { grade_value: "9", records: [record(500, 1)] }, // base only — dropped under Gold mode
            { grade_value: "8", records: [record(300, 1)] }, // base only — dropped
          ],
        },
      ],
    };
    const out = buildGradeBreakdown(pricing, GOLD);
    expect(out).toHaveLength(1);
    expect(out[0].grade).toBe("10");
  });

  it("recentDirection: emitted when ≥6 dated records with recent-vs-prior spread", () => {
    const pricing: any = {
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "PSA",
          grades: [
            {
              grade_value: "10",
              records: [
                // Recent 7 at high prices (recent date = newest)
                record(1200, 0),
                record(1200, 1),
                record(1200, 2),
                record(1200, 3),
                record(1200, 4),
                record(1200, 5),
                record(1200, 6),
                // Prior 7 at low prices
                record(800, 7),
                record(800, 8),
                record(800, 9),
                record(800, 10),
                record(800, 11),
                record(800, 12),
                record(800, 13),
              ],
            },
          ],
        },
      ],
    };
    const out = buildGradeBreakdown(pricing, null);
    expect(out[0].recentDirection).toBe("up"); // 1200/800 = 1.5 → up
  });

  it("recentDirection: OMITTED when fewer than 6 dated records (no fabrication)", () => {
    const pricing: any = {
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "PSA",
          grades: [
            { grade_value: "10", records: [record(1000, 1), record(1100, 3), record(1050, 5)] },
          ],
        },
      ],
    };
    const out = buildGradeBreakdown(pricing, null);
    expect(out[0].recentDirection).toBeUndefined();
  });

  it("sort: PSA → BGS → SGC → CGC → others; numeric grade desc within company", () => {
    const pricing: any = {
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "SGC",
          grades: [
            { grade_value: "10", records: [record(800, 1)] },
            { grade_value: "9.5", records: [record(700, 1)] },
            { grade_value: "Authentic", records: [record(400, 1)] },
          ],
        },
        {
          company_name: "PSA",
          grades: [
            { grade_value: "10", records: [record(1500, 1)] },
            { grade_value: "9", records: [record(1000, 1)] },
          ],
        },
        {
          company_name: "BGS",
          grades: [{ grade_value: "9.5", records: [record(1200, 1)] }],
        },
        {
          company_name: "HGA",
          grades: [{ grade_value: "10", records: [record(500, 1)] }],
        },
      ],
    };
    const out = buildGradeBreakdown(pricing, null);
    const order = out.map((e) => `${e.grader} ${e.grade}`);
    expect(order).toEqual([
      "PSA 10",
      "PSA 9",
      "BGS 9.5",
      "SGC 10",
      "SGC 9.5",
      "SGC Authentic", // non-numeric goes last within SGC
      "HGA 10", // off-list company goes last
    ]);
  });

  it("median is whole-dollar (rounded)", () => {
    const pricing: any = {
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "PSA",
          grades: [
            { grade_value: "10", records: [record(100.49, 1), record(100.51, 2)] },
          ],
        },
      ],
    };
    const out = buildGradeBreakdown(pricing, null);
    expect(out[0].median).toBe(101); // round((100.49+100.51)/2)
    expect(Number.isInteger(out[0].median)).toBe(true);
  });

  it("empty pricing.graded → empty array (no fabricated entries)", () => {
    const pricing: any = { raw: { count: 0, records: [] }, graded: [] };
    expect(buildGradeBreakdown(pricing, null)).toEqual([]);
  });

  it("only invalid prices in a bucket → dropped", () => {
    const pricing: any = {
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "PSA",
          grades: [
            {
              grade_value: "10",
              records: [
                { ...record(0, 1) }, // zero → invalid
                { ...record(-5, 2) }, // negative → invalid
              ],
            },
          ],
        },
      ],
    };
    expect(buildGradeBreakdown(pricing, null)).toEqual([]);
  });
});

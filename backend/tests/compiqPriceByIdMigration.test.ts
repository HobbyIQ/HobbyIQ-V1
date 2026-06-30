// CF-PRICE-BY-ID-MIGRATION — coverage retained post-CF-CARDHEDGE-
// NAMING-CLEANUP. Dual-accept transition for the legacy cardHedgeCardId
// wire key has been removed; cardId is the sole accepted form.
//
// Covers:
//   1. selectSalesByGrade helper (Raw, PSA 10, BGS 9.5, malformed grade,
//      missing company, missing grade value) — direct unit tests of the
//      client-side grade filter.
//   2. /api/compiq/price-by-id cardId wire-key handling.
//   3. /api/compiq/price-by-id missing-field rejection: 400 when the
//      cardId field is missing or empty.
//   4. Legacy cardHedgeCardId in request body is silently ignored (no
//      destructure, no dual-accept) — request lacking cardId
//      returns 400 regardless of whether legacy field is present.

import { describe, expect, it, vi } from "vitest";
import request from "supertest";

// CF-PAYMENTS-B1: /api/compiq/price-by-id is now session-gated.
vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => ({
      userId: "test-user",
      email: "t@t",
      username: null,
      fullName: null,
      plan: "pro_seller",
      createdAt: "2026-01-01T00:00:00Z",
    })),
  };
});

import app from "../src/app";
import {
  selectSalesByGrade,
  filterRecordsByParallel,
} from "../src/services/compiq/compiqEstimate.service";
import type { CardsightSaleRecord } from "../src/services/compiq/catalogSource";

function makeRecord(price: number, title = "fixture"): CardsightSaleRecord {
  return {
    title,
    price,
    date: "2026-05-01",
    source: "ebay",
    url: null,
  };
}

describe("selectSalesByGrade (CF-PRICE-BY-ID-MIGRATION grade filter)", () => {
  const raw = [makeRecord(100, "raw1"), makeRecord(110, "raw2")];
  const psa10 = [makeRecord(500, "psa10-a"), makeRecord(520, "psa10-b")];
  const psa9 = [makeRecord(300, "psa9-a")];
  const bgs95 = [makeRecord(450, "bgs95-a")];

  const pricing = {
    raw: { records: raw },
    graded: [
      {
        company_name: "PSA",
        grades: [
          { grade_value: "10", records: psa10 },
          { grade_value: "9", records: psa9 },
        ],
      },
      {
        company_name: "BGS",
        grades: [{ grade_value: "9.5", records: bgs95 }],
      },
    ],
  };

  it("Raw grade returns raw records (ungraded)", () => {
    expect(selectSalesByGrade(pricing, "Raw")).toBe(raw);
  });

  it('"PSA 10" returns the PSA 10 records', () => {
    expect(selectSalesByGrade(pricing, "PSA 10")).toEqual(psa10);
  });

  it('"PSA 9" returns the PSA 9 records', () => {
    expect(selectSalesByGrade(pricing, "PSA 9")).toEqual(psa9);
  });

  it('"BGS 9.5" returns the BGS 9.5 records (decimal grade values supported)', () => {
    expect(selectSalesByGrade(pricing, "BGS 9.5")).toEqual(bgs95);
  });

  it("case-insensitive on the company name", () => {
    expect(selectSalesByGrade(pricing, "psa 10")).toEqual(psa10);
  });

  it("missing company (SGC requested, not in pricing.graded) returns []", () => {
    expect(selectSalesByGrade(pricing, "SGC 10")).toEqual([]);
  });

  it("missing grade value within an existing company returns []", () => {
    expect(selectSalesByGrade(pricing, "PSA 8")).toEqual([]);
  });

  it("malformed grade string falls back to raw records", () => {
    expect(selectSalesByGrade(pricing, "garbage")).toBe(raw);
  });

  it("empty grade string falls back to raw records", () => {
    expect(selectSalesByGrade(pricing, "")).toBe(raw);
  });

  it("pricing with no raw block returns [] for Raw request", () => {
    const noRaw = { graded: pricing.graded };
    expect(selectSalesByGrade(noRaw, "Raw")).toEqual([]);
  });

  // CF-GRADED-PRICE-BY-ID-ZERO-COMPS (2026-06-08):
  // - Cardsight's wire shape carries grade_value as string OR number across
  //   companies / cards. Strict === broke the numeric-typed graded buckets
  //   (observed in production: fda530ab PSA 10 had 207 records on the wire
  //   that selectSalesByGrade dropped to 0).
  // - The same payload can list the same grade_value across multiple
  //   `grades[]` entries (fda530ab PSA 9 = 117 + 3, BGS 10 = 1 + 4).
  //   .find returned the first only; .filter + flatMap concatenates.
  describe("wire-type drift + duplicate-bucket merge (CF-GRADED-ZERO-COMPS)", () => {
    it('grade_value as number 9 matches "PSA 9" request', () => {
      const numericPricing = {
        raw: { records: raw },
        graded: [
          {
            company_name: "PSA",
            grades: [{ grade_value: 9 as unknown as string, records: psa9 }],
          },
        ],
      };
      expect(selectSalesByGrade(numericPricing, "PSA 9")).toEqual(psa9);
    });

    it('grade_value as string "9.0" matches "PSA 9" request', () => {
      const decimalStringPricing = {
        raw: { records: raw },
        graded: [
          {
            company_name: "PSA",
            grades: [{ grade_value: "9.0", records: psa9 }],
          },
        ],
      };
      expect(selectSalesByGrade(decimalStringPricing, "PSA 9")).toEqual(psa9);
    });

    it('grade_value as number 9.5 matches "BGS 9.5" request', () => {
      const numericDecimalPricing = {
        raw: { records: raw },
        graded: [
          {
            company_name: "BGS",
            grades: [{ grade_value: 9.5 as unknown as string, records: bgs95 }],
          },
        ],
      };
      expect(selectSalesByGrade(numericDecimalPricing, "BGS 9.5")).toEqual(bgs95);
    });

    it("duplicate grade_value buckets merge (PSA 9 split across two entries)", () => {
      const dupPsa9Extra = [makeRecord(305, "psa9-c"), makeRecord(310, "psa9-d")];
      const dupPricing = {
        raw: { records: raw },
        graded: [
          {
            company_name: "PSA",
            grades: [
              { grade_value: "9", records: psa9 },
              { grade_value: "10", records: psa10 },
              { grade_value: "9", records: dupPsa9Extra },
            ],
          },
        ],
      };
      expect(selectSalesByGrade(dupPricing, "PSA 9")).toEqual([...psa9, ...dupPsa9Extra]);
    });

    it("duplicate grade_value buckets with mixed types both merge", () => {
      const stringBucket = [makeRecord(500, "psa10-string")];
      const numberBucket = [makeRecord(520, "psa10-num")];
      const mixedPricing = {
        raw: { records: raw },
        graded: [
          {
            company_name: "PSA",
            grades: [
              { grade_value: "10", records: stringBucket },
              { grade_value: 10 as unknown as string, records: numberBucket },
            ],
          },
        ],
      };
      expect(selectSalesByGrade(mixedPricing, "PSA 10")).toEqual([
        ...stringBucket,
        ...numberBucket,
      ]);
    });
  });
});

describe("/api/compiq/price-by-id wire-key handling (post-CF-CARDHEDGE-NAMING-CLEANUP)", () => {
  it("accepts the cardId wire key", async () => {
    const res = await request(app)
      .post("/api/compiq/price-by-id")
      .set("x-session-id", "test-sess")
      .send({ cardId: "fixture-card-id" });
    expect(res.status).toBe(200);
  });

  it("400 when cardId is missing, error names the field", async () => {
    const res = await request(app).post("/api/compiq/price-by-id").set("x-session-id", "test-sess").send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'Missing "cardId" field',
    });
  });

  it("400 when only the legacy cardHedgeCardId wire key is sent (no dual-accept; field ignored)", async () => {
    const res = await request(app)
      .post("/api/compiq/price-by-id")
      .set("x-session-id", "test-sess")
      .send({ cardHedgeCardId: "legacy-card-id" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'Missing "cardId" field',
    });
  });

  it("cardId is used when both keys are sent (legacy silently ignored)", async () => {
    const res = await request(app)
      .post("/api/compiq/price-by-id")
      .set("x-session-id", "test-sess")
      .send({
        cardId: "fixture-card-id",
        cardHedgeCardId: "legacy-card-id",
      });
    expect(res.status).toBe(200);
    expect(res.body.cardId).toBe("fixture-card-id");
  });

  // CF-PARALLEL-AWARE-VALUE (2026-06-09): parallelId UUID validation.
  it("400 when parallelId is not UUID-shaped", async () => {
    const res = await request(app)
      .post("/api/compiq/price-by-id")
      .set("x-session-id", "test-sess")
      .send({
        cardId: "00000000-0000-0000-0000-000000000000",
        parallelId: "not-a-uuid",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/parallelId/);
  });

  it("200 when parallelId is a valid UUID", async () => {
    const res = await request(app)
      .post("/api/compiq/price-by-id")
      .set("x-session-id", "test-sess")
      .send({
        cardId: "00000000-0000-0000-0000-000000000000",
        parallelId: "b44f73a5-3100-41d5-8235-047636739e6e",
        parallelName: "Gold",
      });
    expect(res.status).toBe(200);
  });
});

describe("filterRecordsByParallel (CF-PARALLEL-AWARE-VALUE)", () => {
  const baseA = makeRecord(200, "Base A");
  const baseB = makeRecord(220, "Base B");
  const goldA = { ...makeRecord(800, "Gold A"), parallel_id: "GOLD-UUID", parallel_name: "Gold" };
  const goldB = { ...makeRecord(900, "Gold B"), parallel_id: "GOLD-UUID", parallel_name: "Gold" };
  const cognac = { ...makeRecord(2400, "Cognac"), parallel_id: "COGNAC-UUID", parallel_name: "Cognac Diamond" };
  const mixed = [baseA, baseB, goldA, goldB, cognac];

  it("base mode (no parallelId): keeps only records WITHOUT parallel_id", () => {
    const out = filterRecordsByParallel(mixed, null);
    expect(out).toEqual([baseA, baseB]);
  });

  it("base mode (undefined parallelId): same as null", () => {
    expect(filterRecordsByParallel(mixed, undefined)).toEqual([baseA, baseB]);
  });

  it("parallel mode (GOLD-UUID): keeps only Gold records, drops base AND other parallels", () => {
    expect(filterRecordsByParallel(mixed, "GOLD-UUID")).toEqual([goldA, goldB]);
  });

  it("parallel mode (COGNAC-UUID): isolates Cognac, drops base + Gold", () => {
    expect(filterRecordsByParallel(mixed, "COGNAC-UUID")).toEqual([cognac]);
  });

  it("unknown parallelId returns empty (honest no-comps; never falls back to base)", () => {
    expect(filterRecordsByParallel(mixed, "UNKNOWN-UUID")).toEqual([]);
  });

  it("empty input returns empty", () => {
    expect(filterRecordsByParallel([], null)).toEqual([]);
    expect(filterRecordsByParallel([], "GOLD-UUID")).toEqual([]);
  });

  it("treats parallel_id=null AS base when querying base (no parallelId)", () => {
    // When the caller asks for base (parallelId=null), records with
    // parallel_id=null OR undefined are returned. Unchanged from
    // pre-CF-CH-PARALLEL-FILTER-BYPASS.
    const withNullPid: { parallel_id: null; title: string; price: number; soldDate: string; grade: string; source: string } =
      { ...makeRecord(150, "null-pid"), parallel_id: null };
    expect(filterRecordsByParallel([withNullPid], null)).toEqual([withNullPid]);
  });

  it("CF-CH-PARALLEL-FILTER-BYPASS: when NO record carries parallel_id, returns input as-is regardless of parallelId arg", () => {
    // CardHedge replaced Cardsight (Wave 3); CH does NOT carry
    // parallel_id (each parallel has its own card_id, so sales returned
    // by getCardSales(parallelCardId) are already parallel-scoped
    // upstream). Pre-CF, the strict UUID equality below dropped every
    // CH record → 0-comp fall-through → engine forced into Build B
    // math (e.g., Hartman Speckle /299 returned $22). The CF makes the
    // strict filter bypass when no record has parallel_id.
    //
    // Test mirrors the deployed CH shape: records with `parallel_id`
    // absent entirely (undefined). Both null-parallelId and
    // "GOLD-UUID"-parallelId paths return the input as-is — the caller
    // already filtered upstream via the parallel-specific card_id.
    const chShape = [
      { title: "ch-1", price: 100, soldDate: "2026-05-01", grade: "Raw", source: "cardhedge" },
      { title: "ch-2", price: 110, soldDate: "2026-05-02", grade: "Raw", source: "cardhedge" },
    ];
    expect(filterRecordsByParallel(chShape, null)).toEqual(chShape);
    expect(filterRecordsByParallel(chShape, "GOLD-UUID")).toEqual(chShape);
  });
});

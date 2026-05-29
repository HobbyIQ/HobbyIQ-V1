// CF-PRICE-BY-ID-MIGRATION — coverage retained post-CF-CARDHEDGE-
// NAMING-CLEANUP. Dual-accept transition for the legacy cardHedgeCardId
// wire key has been removed; cardsightCardId is the sole accepted form.
//
// Covers:
//   1. selectSalesByGrade helper (Raw, PSA 10, BGS 9.5, malformed grade,
//      missing company, missing grade value) — direct unit tests of the
//      client-side grade filter.
//   2. /api/compiq/price-by-id cardsightCardId wire-key handling.
//   3. /api/compiq/price-by-id missing-field rejection: 400 when the
//      cardsightCardId field is missing or empty.
//   4. Legacy cardHedgeCardId in request body is silently ignored (no
//      destructure, no dual-accept) — request lacking cardsightCardId
//      returns 400 regardless of whether legacy field is present.

import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app";
import {
  selectSalesByGrade,
} from "../src/services/compiq/compiqEstimate.service";
import type { CardsightSaleRecord } from "../src/services/compiq/cardsight.client";

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
    expect(selectSalesByGrade(pricing, "PSA 10")).toBe(psa10);
  });

  it('"PSA 9" returns the PSA 9 records', () => {
    expect(selectSalesByGrade(pricing, "PSA 9")).toBe(psa9);
  });

  it('"BGS 9.5" returns the BGS 9.5 records (decimal grade values supported)', () => {
    expect(selectSalesByGrade(pricing, "BGS 9.5")).toBe(bgs95);
  });

  it("case-insensitive on the company name", () => {
    expect(selectSalesByGrade(pricing, "psa 10")).toBe(psa10);
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
});

describe("/api/compiq/price-by-id wire-key handling (post-CF-CARDHEDGE-NAMING-CLEANUP)", () => {
  it("accepts the cardsightCardId wire key", async () => {
    const res = await request(app)
      .post("/api/compiq/price-by-id")
      .send({ cardsightCardId: "fixture-card-id" });
    expect(res.status).toBe(200);
  });

  it("400 when cardsightCardId is missing, error names the field", async () => {
    const res = await request(app).post("/api/compiq/price-by-id").send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'Missing "cardsightCardId" field',
    });
  });

  it("400 when only the legacy cardHedgeCardId wire key is sent (no dual-accept; field ignored)", async () => {
    const res = await request(app)
      .post("/api/compiq/price-by-id")
      .send({ cardHedgeCardId: "legacy-card-id" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'Missing "cardsightCardId" field',
    });
  });

  it("cardsightCardId is used when both keys are sent (legacy silently ignored)", async () => {
    const res = await request(app)
      .post("/api/compiq/price-by-id")
      .send({
        cardsightCardId: "fixture-card-id",
        cardHedgeCardId: "legacy-card-id",
      });
    expect(res.status).toBe(200);
    expect(res.body.cardsightCardId).toBe("fixture-card-id");
  });
});

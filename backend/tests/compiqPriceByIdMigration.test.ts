// CF-PRICE-BY-ID-MIGRATION — coverage for the new behavior shipped by
// the first sub-CF of CF-CARDHEDGE-DECOMMISSION-FULL Phase 2.
//
// Covers:
//   1. selectSalesByGrade helper (Raw, PSA 10, BGS 9.5, malformed grade,
//      missing company, missing grade value) — direct unit tests of the
//      client-side grade filter that replaces CardHedge's server-side
//      filtering.
//   2. /api/compiq/price-by-id dual-accept transition (D1 wire-gap
//      Option a): legacy cardHedgeCardId still works + emits a
//      structured warn event with the exact agreed shape; new
//      cardsightCardId is the preferred wire key.
//   3. /api/compiq/price-by-id missing-field rejection: requests with
//      neither key return 400 with the updated error message.
//
// Tests at (1) are pure-function unit tests. Tests at (2)/(3) hit the
// real route via supertest using the same fixture-card-id pattern as
// compiqRoutePredictionShape.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("/api/compiq/price-by-id wire-key handling (CF-PRICE-BY-ID-MIGRATION)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("accepts the new cardsightCardId wire key without emitting the legacy-key warn event", async () => {
    const res = await request(app)
      .post("/api/compiq/price-by-id")
      .send({ cardsightCardId: "fixture-card-id" });
    expect(res.status).toBe(200);

    const legacyEvents = warnSpy.mock.calls
      .map((args) => (typeof args[0] === "string" ? args[0] : ""))
      .filter((s) => s.includes("compiq_priceByIdLegacyKey_used"));
    expect(legacyEvents.length).toBe(0);
  });

  it("dual-accept: legacy cardHedgeCardId still works and emits the structured warn event", async () => {
    const res = await request(app)
      .post("/api/compiq/price-by-id")
      .send({ cardHedgeCardId: "fixture-card-id" });
    expect(res.status).toBe(200);

    const legacyEvents = warnSpy.mock.calls
      .map((args) => (typeof args[0] === "string" ? args[0] : ""))
      .filter((s) => s.includes("compiq_priceByIdLegacyKey_used"));
    expect(legacyEvents.length).toBeGreaterThanOrEqual(1);

    // Exact agreed shape (mirrors the lock from Drew's D1 wire-gap
    // decision lock).
    const parsed = JSON.parse(legacyEvents[0]);
    expect(parsed).toEqual({
      event: "compiq_priceByIdLegacyKey_used",
      source: "compiq.routes.priceByIdHandler",
      legacyKey: "cardHedgeCardId",
      recommendedKey: "cardsightCardId",
    });
  });

  it("400 when neither cardsightCardId nor cardHedgeCardId is provided, error names the new field", async () => {
    const res = await request(app).post("/api/compiq/price-by-id").send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'Missing "cardsightCardId" field',
    });

    // Missing-field path does NOT emit the legacy-key warn event —
    // the event fires only on the successful dual-accept path.
    const legacyEvents = warnSpy.mock.calls
      .map((args) => (typeof args[0] === "string" ? args[0] : ""))
      .filter((s) => s.includes("compiq_priceByIdLegacyKey_used"));
    expect(legacyEvents.length).toBe(0);
  });

  it("cardsightCardId takes precedence when both keys are sent (no warn event)", async () => {
    const res = await request(app)
      .post("/api/compiq/price-by-id")
      .send({
        cardsightCardId: "fixture-card-id",
        cardHedgeCardId: "legacy-card-id",
      });
    expect(res.status).toBe(200);
    // Response echoes cardsightCardId (the preferred wire-key form).
    expect(res.body.cardsightCardId).toBe("fixture-card-id");

    // Warn event does not fire when the new key is also provided.
    const legacyEvents = warnSpy.mock.calls
      .map((args) => (typeof args[0] === "string" ? args[0] : ""))
      .filter((s) => s.includes("compiq_priceByIdLegacyKey_used"));
    expect(legacyEvents.length).toBe(0);
  });
});

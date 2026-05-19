/**
 * Unit tests for cardsight.translator.ts
 *
 * All inputs are inline fixture objects — no HTTP calls, no mocking needed.
 * Tests verify the grade filtering algorithm, sort order, source tagging,
 * and edge cases (empty response, missing company, missing grade value).
 */
import { describe, it, expect, vi } from "vitest";

import { translateResponse } from "../src/services/compiq/cardsight.translator.js";
import type { CardsightPricingResponse } from "../src/services/compiq/cardsight.client.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const RAW_RECORDS = [
  { title: "Ohtani 2018 Topps Chrome Raw", price: 45.00, date: "2026-05-08", source: "ebay", url: null },
  { title: "Ohtani 2018 Topps Chrome Raw #2", price: 42.00, date: "2026-05-10", source: "ebay", url: null },
  { title: "Ohtani 2018 Topps Chrome Raw #3", price: 44.00, date: "2026-05-09", source: "ebay", url: null },
];

const PSA_10_RECORDS = [
  { title: "Ohtani 2018 Topps Chrome PSA 10 A", price: 95.00, date: "2026-05-09", source: "goldin", url: null },
  { title: "Ohtani 2018 Topps Chrome PSA 10 B", price: 92.00, date: "2026-05-07", source: "ebay", url: null },
];

const PSA_9_RECORDS = [
  { title: "Ohtani 2018 Topps Chrome PSA 9", price: 55.00, date: "2026-05-06", source: "ebay", url: null },
];

const SGC_10_RECORDS = [
  { title: "Ohtani 2018 Topps Chrome SGC 10", price: 70.00, date: "2026-05-05", source: "ebay", url: null },
];

function buildResponse(overrides: Partial<CardsightPricingResponse> = {}): CardsightPricingResponse {
  return {
    raw: { count: RAW_RECORDS.length, records: RAW_RECORDS },
    graded: [
      {
        company_name: "PSA",
        grades: [
          { grade_value: "10", count: 2, records: PSA_10_RECORDS },
          { grade_value: "9",  count: 1, records: PSA_9_RECORDS  },
        ],
      },
      {
        company_name: "SGC",
        grades: [
          { grade_value: "10", count: 1, records: SGC_10_RECORDS },
        ],
      },
    ],
    meta: { total_records: 10, last_sale_date: "2026-05-09" },
    ...overrides,
  };
}

// ─── Raw path ─────────────────────────────────────────────────────────────────

describe("translateResponse — raw path", () => {
  it("returns raw records when gradeCompany is not provided", () => {
    const result = translateResponse(buildResponse(), {});
    expect(result).toHaveLength(3);
  });

  it("all returned comps have source='cardsight'", () => {
    const result = translateResponse(buildResponse(), {});
    expect(result.every((c) => c.source === "cardsight")).toBe(true);
  });

  it("raw comps are sorted by soldDate descending (newest first)", () => {
    const result = translateResponse(buildResponse(), {});
    expect(result[0].soldDate).toBe("2026-05-10");
    expect(result[1].soldDate).toBe("2026-05-09");
    expect(result[2].soldDate).toBe("2026-05-08");
  });

  it("maps price and title fields correctly", () => {
    const result = translateResponse(buildResponse(), {});
    const byDate = result.find((c) => c.soldDate === "2026-05-10")!;
    expect(byDate.price).toBe(42.00);
    expect(byDate.title).toBe("Ohtani 2018 Topps Chrome Raw #2");
  });

  it("returns [] when raw.records is empty", () => {
    const response = buildResponse({ raw: { count: 0, records: [] } });
    const result = translateResponse(response, {});
    expect(result).toEqual([]);
  });
});

// ─── Graded path — specific grade ────────────────────────────────────────────

describe("translateResponse — graded path (specific grade)", () => {
  it("returns only PSA 10 records when gradeCompany=PSA gradeValue=10", () => {
    const result = translateResponse(buildResponse(), {
      gradeCompany: "PSA",
      gradeValue: "10",
    });
    expect(result).toHaveLength(2);
    expect(result.every((c) => c.source === "cardsight")).toBe(true);
  });

  it("does NOT include PSA 9 records when gradeValue=10 is requested", () => {
    const result = translateResponse(buildResponse(), { gradeCompany: "PSA", gradeValue: "10" });
    expect(result.some((c) => c.price === 55.00)).toBe(false);
  });

  it("returns only PSA 9 records when gradeValue=9 is requested", () => {
    const result = translateResponse(buildResponse(), { gradeCompany: "PSA", gradeValue: "9" });
    expect(result).toHaveLength(1);
    expect(result[0].price).toBe(55.00);
  });

  it("returns graded comps sorted by soldDate descending", () => {
    const result = translateResponse(buildResponse(), { gradeCompany: "PSA", gradeValue: "10" });
    expect(result[0].soldDate).toBe("2026-05-09");
    expect(result[1].soldDate).toBe("2026-05-07");
  });
});

// ─── Graded path — all grades for a company ───────────────────────────────────

describe("translateResponse — graded path (all grades for company)", () => {
  it("returns all PSA grades when gradeCompany=PSA and gradeValue is omitted", () => {
    const result = translateResponse(buildResponse(), { gradeCompany: "PSA" });
    // PSA 10: 2 records, PSA 9: 1 record = 3 total
    expect(result).toHaveLength(3);
  });

  it("returns only SGC records and not PSA when gradeCompany=SGC", () => {
    const result = translateResponse(buildResponse(), { gradeCompany: "SGC" });
    expect(result).toHaveLength(1);
    expect(result[0].price).toBe(70.00);
  });
});

// ─── Grade company case-insensitivity ─────────────────────────────────────────

describe("translateResponse — case-insensitive company matching", () => {
  it("matches 'psa' (lowercase) against company_name='PSA'", () => {
    const result = translateResponse(buildResponse(), { gradeCompany: "psa", gradeValue: "10" });
    expect(result).toHaveLength(2);
  });

  it("matches 'Psa' (mixed case) against company_name='PSA'", () => {
    const result = translateResponse(buildResponse(), { gradeCompany: "Psa", gradeValue: "10" });
    expect(result).toHaveLength(2);
  });
});

// ─── Missing company / grade ──────────────────────────────────────────────────

describe("translateResponse — missing company or grade", () => {
  it("returns [] and warns when gradeCompany not found in response", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = translateResponse(buildResponse(), { gradeCompany: "BGS", gradeValue: "9.5" });
    expect(result).toEqual([]);
    expect(logSpy).toHaveBeenCalled();
    const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(parsed.event).toBe("grade_company_not_found");
    expect(parsed.requestedGradeCompany).toBe("BGS");
    logSpy.mockRestore();
  });

  it("returns [] and warns when gradeValue not found within company", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = translateResponse(buildResponse(), { gradeCompany: "PSA", gradeValue: "8" });
    expect(result).toEqual([]);
    expect(logSpy).toHaveBeenCalled();
    const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(parsed.event).toBe("grade_value_not_found");
    expect(parsed.requestedGradeCompany).toBe("PSA");
    expect(parsed.requestedGradeValue).toBe("8");
    logSpy.mockRestore();
  });

  it("does NOT mix SGC records into result when PSA is requested", () => {
    const result = translateResponse(buildResponse(), { gradeCompany: "PSA", gradeValue: "10" });
    const hasSgcRecord = result.some((c) => c.title.includes("SGC"));
    expect(hasSgcRecord).toBe(false);
  });
});

// ─── Empty / degenerate responses ─────────────────────────────────────────────

describe("translateResponse — empty / degenerate responses", () => {
  it("returns [] when response has empty graded array and graded path requested", () => {
    const response = buildResponse({ graded: [] });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = translateResponse(response, { gradeCompany: "PSA" });
    expect(result).toEqual([]);
    expect(logSpy).toHaveBeenCalled();
    const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(parsed.event).toBe("grade_company_not_found");
    logSpy.mockRestore();
  });

  it("returns [] when both raw and graded are empty and no gradeCompany", () => {
    const response: CardsightPricingResponse = {
      raw: { count: 0, records: [] },
      graded: [],
      meta: { total_records: 0, last_sale_date: null },
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(translateResponse(response, {})).toEqual([]);
    expect(logSpy).toHaveBeenCalled();
    const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(parsed.event).toBe("empty_response");
    logSpy.mockRestore();
  });

  it("handles records with null date — sorts empty soldDate to bottom", () => {
    const response: CardsightPricingResponse = {
      raw: {
        count: 2,
        records: [
          { title: "Card A", price: 10, date: null, source: "ebay", url: null },
          { title: "Card B", price: 20, date: "2026-05-10", source: "ebay", url: null },
        ],
      },
      graded: [],
      meta: { total_records: 2, last_sale_date: null },
    };
    const result = translateResponse(response, {});
    expect(result[0].soldDate).toBe("2026-05-10");
    expect(result[1].soldDate).toBe("");
  });
});

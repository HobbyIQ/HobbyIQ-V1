// CF-ML-MOAT-OUTCOMES — capture job + state machine tests.
//
// Coverage map (per CF spec):
//   1. graded PSA10 + sales in (T, T+7]  -> cardsight_graded_window + median + TERMINAL
//   2. raw card + sales in window         -> cardsight_raw_window
//   3. zero in-window sales               -> no_sales_in_window TERMINAL (NOT re-queued)
//   4. notFound                            -> not_found TERMINAL
//   5. Cardsight throws (timeout/api err) -> upstream_error, retry; cap at 5
//   6. idempotent: second run is no-op
//   7. per-run cap: 51 candidates, MAX=50 -> 50 processed, 1 deferred
//   8. window boundaries: T excluded, T+7 included, T+8 excluded
//   9. ingestion buffer: T+7 not candidate; T+9 IS

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";

// Mock Cardsight's getPricing at the module boundary. The service's
// captureOutcome catches CardsightApiError / CardsightTimeoutError to
// route to upstream_error; tests inject those via mockRejectedValueOnce.
const { getPricingMock } = vi.hoisted(() => ({
  getPricingMock: vi.fn(),
}));

vi.mock("../src/services/compiq/cardsight.client.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getPricing: getPricingMock,
  };
});

const serviceMod = await import("../src/services/outcomes/predictionOutcomes.service.js");
const jobMod = await import("../src/jobs/predictionOutcomesCapture.job.ts");

const ENGINE_VERSION = "test-sha";
const RUN_ID = "test-run-id";

// Stable "now" so window math is deterministic across tests. All sample
// predictions are timestamped before this; horizon math is in days.
const T_NOW = new Date("2026-06-20T12:00:00.000Z");

function makePrediction(opts: {
  id: string;
  timestamp: string;
  cardsightCardId?: string;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  joinable?: boolean;
}): any {
  return {
    id: opts.id,
    cardsightCardId: opts.cardsightCardId ?? `card-${opts.id}`,
    timestamp: opts.timestamp,
    joinable: opts.joinable ?? true,
    gradeCompany: opts.gradeCompany ?? null,
    gradeValue: opts.gradeValue ?? null,
  };
}

function pricingWithGraded(opts: {
  company: string;
  grade: string;
  records: Array<{ price: number; date: string | null }>;
}) {
  return {
    raw: { count: 0, records: [] },
    graded: [
      {
        company_name: opts.company,
        grades: [
          {
            grade_value: opts.grade,
            count: opts.records.length,
            records: opts.records.map((r) => ({
              title: "x",
              price: r.price,
              date: r.date,
              source: "cs",
              url: null,
            })),
          },
        ],
      },
    ],
    meta: { total_records: opts.records.length, last_sale_date: null },
  };
}

function pricingWithRaw(records: Array<{ price: number; date: string | null }>) {
  return {
    raw: {
      count: records.length,
      records: records.map((r) => ({
        title: "x",
        price: r.price,
        date: r.date,
        source: "cs",
        url: null,
      })),
    },
    graded: [],
    meta: { total_records: records.length, last_sale_date: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceMod._resetForTests();
});

afterEach(() => {
  serviceMod._resetForTests();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. graded happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("captureOutcome — graded happy path", () => {
  it("graded PSA10 with 3 in-window sales -> cardsight_graded_window + median + TERMINAL", async () => {
    const prediction = makePrediction({
      id: "p1",
      timestamp: "2026-06-01T00:00:00.000Z",
      gradeCompany: "PSA",
      gradeValue: 10,
    });
    getPricingMock.mockResolvedValueOnce(
      pricingWithGraded({
        company: "PSA",
        grade: "10",
        records: [
          { price: 100, date: "2026-06-03T00:00:00.000Z" }, // in window
          { price: 200, date: "2026-06-05T00:00:00.000Z" }, // in window
          { price: 150, date: "2026-06-07T00:00:00.000Z" }, // in window (== T+6)
          { price: 999, date: "2026-06-10T00:00:00.000Z" }, // OUT (T+9)
          { price: 999, date: "2026-06-01T00:00:00.000Z" }, // OUT (== T)
        ],
      }),
    );
    const r = await serviceMod.captureOutcome(prediction, {
      horizonDays: 7,
      runId: RUN_ID,
      engineVersion: ENGINE_VERSION,
      now: T_NOW,
    });
    expect(r.outcomeSource).toBe("cardsight_graded_window");
    expect(r.terminal).toBe(true);
    expect(r.nSalesInWindow).toBe(3);
    expect(r.realizedOutcomePrice).toBe(150); // median of [100, 150, 200]
    expect(r.captureAttempt).toBe(1);
    expect(r.cardsightCallsUsed).toBe(1);

    const stored = await serviceMod._peekOutcomeForTests("p1", "card-p1", 7);
    expect(stored).not.toBeNull();
    expect(stored!.realizedOutcomeAggregation).toBe("median");
    expect(stored!.salesSample).toHaveLength(3);
    expect(stored!.windowStart).toBe("2026-06-01T00:00:00.000Z");
    expect(stored!.windowEnd).toBe("2026-06-08T00:00:00.000Z");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. raw happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("captureOutcome — raw happy path", () => {
  it("raw card (no gradeCompany) -> cardsight_raw_window", async () => {
    const prediction = makePrediction({
      id: "p-raw",
      timestamp: "2026-06-01T00:00:00.000Z",
      gradeCompany: null,
      gradeValue: null,
    });
    getPricingMock.mockResolvedValueOnce(
      pricingWithRaw([
        { price: 50, date: "2026-06-04T00:00:00.000Z" },
        { price: 70, date: "2026-06-06T00:00:00.000Z" },
      ]),
    );
    const r = await serviceMod.captureOutcome(prediction, {
      horizonDays: 7,
      runId: RUN_ID,
      engineVersion: ENGINE_VERSION,
      now: T_NOW,
    });
    expect(r.outcomeSource).toBe("cardsight_raw_window");
    expect(r.terminal).toBe(true);
    expect(r.nSalesInWindow).toBe(2);
    expect(r.realizedOutcomePrice).toBe(60); // median of [50, 70]
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. zero in-window sales → no_sales_in_window TERMINAL
// ─────────────────────────────────────────────────────────────────────────────

describe("captureOutcome — no_sales_in_window TERMINAL", () => {
  it("re-query OK but zero in-window sales -> no_sales_in_window, TERMINAL, NOT re-queued", async () => {
    const prediction = makePrediction({
      id: "p-illiquid",
      timestamp: "2026-06-01T00:00:00.000Z",
      gradeCompany: "PSA",
      gradeValue: 10,
    });
    // Records exist but all OUTSIDE the (T, T+7] window.
    getPricingMock.mockResolvedValueOnce(
      pricingWithGraded({
        company: "PSA",
        grade: "10",
        records: [
          { price: 100, date: "2026-05-30T00:00:00.000Z" }, // pre-T
          { price: 200, date: "2026-06-20T00:00:00.000Z" }, // post-window
        ],
      }),
    );
    const r1 = await serviceMod.captureOutcome(prediction, {
      horizonDays: 7,
      runId: RUN_ID,
      engineVersion: ENGINE_VERSION,
      now: T_NOW,
    });
    expect(r1.outcomeSource).toBe("no_sales_in_window");
    expect(r1.terminal).toBe(true);
    expect(r1.realizedOutcomePrice).toBeNull();

    // Seed the prediction in the candidate store and verify the next
    // findCandidates() does NOT return it (terminal).
    serviceMod._seedPredictionForTests(prediction);
    const next = await serviceMod.findCandidates({
      horizonDays: 7,
      ingestionBufferDays: 2,
      now: T_NOW,
    });
    expect(next.find((p: any) => p.id === "p-illiquid")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. notFound TERMINAL
// ─────────────────────────────────────────────────────────────────────────────

describe("captureOutcome — not_found TERMINAL", () => {
  it("Cardsight returns notFound -> not_found, TERMINAL", async () => {
    const prediction = makePrediction({
      id: "p-gone",
      timestamp: "2026-06-01T00:00:00.000Z",
    });
    getPricingMock.mockResolvedValueOnce({
      raw: { count: 0, records: [] },
      graded: [],
      meta: { total_records: 0, last_sale_date: null },
      notFound: true,
    });
    const r = await serviceMod.captureOutcome(prediction, {
      horizonDays: 7,
      runId: RUN_ID,
      engineVersion: ENGINE_VERSION,
      now: T_NOW,
    });
    expect(r.outcomeSource).toBe("not_found");
    expect(r.terminal).toBe(true);
    expect(r.realizedOutcomePrice).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Cardsight error: retry up to 5 attempts, then TERMINAL
// ─────────────────────────────────────────────────────────────────────────────

describe("captureOutcome — upstream_error retry then TERMINAL", () => {
  it("first 4 attempts -> non-terminal upstream_error; 5th -> TERMINAL", async () => {
    const prediction = makePrediction({
      id: "p-flaky",
      timestamp: "2026-06-01T00:00:00.000Z",
    });
    const cardsightMod = await import("../src/services/compiq/cardsight.client.js");
    const TimeoutCls = cardsightMod.CardsightTimeoutError;
    for (let attempt = 1; attempt <= 5; attempt++) {
      getPricingMock.mockRejectedValueOnce(new TimeoutCls());
      const r = await serviceMod.captureOutcome(prediction, {
        horizonDays: 7,
        runId: RUN_ID,
        engineVersion: ENGINE_VERSION,
        now: T_NOW,
      });
      expect(r.outcomeSource).toBe("upstream_error");
      expect(r.captureAttempt).toBe(attempt);
      expect(r.terminal).toBe(attempt >= 5);
    }
  });

  it("after 5th attempt, the prediction is NOT re-queued by findCandidates", async () => {
    const prediction = makePrediction({
      id: "p-flaky-2",
      timestamp: "2026-06-01T00:00:00.000Z",
    });
    serviceMod._seedPredictionForTests(prediction);
    const cardsightMod = await import("../src/services/compiq/cardsight.client.js");
    const ApiErr = cardsightMod.CardsightApiError;
    for (let i = 0; i < 5; i++) {
      getPricingMock.mockRejectedValueOnce(new ApiErr("upstream", 502, null));
      await serviceMod.captureOutcome(prediction, {
        horizonDays: 7,
        runId: RUN_ID,
        engineVersion: ENGINE_VERSION,
        now: T_NOW,
      });
    }
    const next = await serviceMod.findCandidates({
      horizonDays: 7,
      ingestionBufferDays: 2,
      now: T_NOW,
    });
    expect(next.find((p: any) => p.id === "p-flaky-2")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Idempotent re-run
// ─────────────────────────────────────────────────────────────────────────────

describe("captureOutcome — idempotency", () => {
  it("re-running on a TERMINAL outcome is a no-op (0 Cardsight calls)", async () => {
    const prediction = makePrediction({
      id: "p-idem",
      timestamp: "2026-06-01T00:00:00.000Z",
      gradeCompany: "PSA",
      gradeValue: 10,
    });
    getPricingMock.mockResolvedValueOnce(
      pricingWithGraded({
        company: "PSA",
        grade: "10",
        records: [{ price: 100, date: "2026-06-03T00:00:00.000Z" }],
      }),
    );
    const r1 = await serviceMod.captureOutcome(prediction, {
      horizonDays: 7,
      runId: RUN_ID,
      engineVersion: ENGINE_VERSION,
      now: T_NOW,
    });
    expect(r1.cardsightCallsUsed).toBe(1);

    // Second call: should NOT touch Cardsight.
    const r2 = await serviceMod.captureOutcome(prediction, {
      horizonDays: 7,
      runId: RUN_ID,
      engineVersion: ENGINE_VERSION,
      now: T_NOW,
    });
    expect(r2.cardsightCallsUsed).toBe(0);
    expect(r2.outcomeSource).toBe("cardsight_graded_window");
    expect(r2.realizedOutcomePrice).toBe(100);
    expect(getPricingMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Per-run cap
// ─────────────────────────────────────────────────────────────────────────────

describe("runPredictionOutcomesCaptureJob — per-run cap", () => {
  it("51 candidates with MAX=50 -> 50 processed, 1 deferred, no error", async () => {
    for (let i = 0; i < 51; i++) {
      serviceMod._seedPredictionForTests(
        makePrediction({
          id: `p-cap-${i}`,
          timestamp: "2026-06-01T00:00:00.000Z",
          gradeCompany: "PSA",
          gradeValue: 10,
        }),
      );
    }
    // Every call returns the same simple in-window pricing.
    getPricingMock.mockResolvedValue(
      pricingWithGraded({
        company: "PSA",
        grade: "10",
        records: [{ price: 100, date: "2026-06-03T00:00:00.000Z" }],
      }),
    );
    const summary = await jobMod.runPredictionOutcomesCaptureJob({
      horizonDays: 7,
      ingestionBufferDays: 2,
      callsPerRunMax: 50,
      now: T_NOW,
    });
    expect(summary.candidatesScanned).toBe(51);
    expect(summary.processed).toBe(50);
    expect(summary.deferredByCap).toBe(1);
    expect(summary.cardsightCallsUsed).toBe(50);
    expect(summary.tuplesNowComplete).toBe(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Window boundary
// ─────────────────────────────────────────────────────────────────────────────

describe("captureOutcome — window boundary", () => {
  it("sale at exactly T excluded; sale at T+7 included; sale at T+8 excluded", async () => {
    const T = "2026-06-01T00:00:00.000Z";
    const T_plus_7 = "2026-06-08T00:00:00.000Z";
    const T_plus_8 = "2026-06-09T00:00:00.000Z";
    const prediction = makePrediction({
      id: "p-boundary",
      timestamp: T,
      gradeCompany: "PSA",
      gradeValue: 10,
    });
    getPricingMock.mockResolvedValueOnce(
      pricingWithGraded({
        company: "PSA",
        grade: "10",
        records: [
          { price: 100, date: T },        // exactly T -> EXCLUDED (half-open start)
          { price: 200, date: T_plus_7 }, // T+7 (windowEnd) -> INCLUDED
          { price: 300, date: T_plus_8 }, // T+8 -> EXCLUDED
        ],
      }),
    );
    const r = await serviceMod.captureOutcome(prediction, {
      horizonDays: 7,
      runId: RUN_ID,
      engineVersion: ENGINE_VERSION,
      now: T_NOW,
    });
    expect(r.nSalesInWindow).toBe(1);
    expect(r.realizedOutcomePrice).toBe(200);
  });

  it("computeWindowEnd is exactly predictionTimestamp + horizonDays * 86400s", () => {
    expect(serviceMod.computeWindowEnd("2026-06-01T00:00:00.000Z", 7)).toBe(
      "2026-06-08T00:00:00.000Z",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Ingestion buffer
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CF-ML-MOAT-OUTCOMES-NORM — selectBucket normalization regression
// ─────────────────────────────────────────────────────────────────────────────

describe("selectBucket — normalization regression (locks against silent no-sales)", () => {
  it("lowercase company + string grade + numeric Cardsight grade -> graded_window match (not no_sales)", async () => {
    // The exact case from the CF spec: format drift on every axis.
    const prediction = makePrediction({
      id: "p-norm",
      timestamp: "2026-06-01T00:00:00.000Z",
      gradeCompany: "psa",                  // ← lowercase (vs Cardsight "PSA")
      gradeValue: "10" as any,              // ← STRING at runtime (TS says number)
    });
    getPricingMock.mockResolvedValueOnce({
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "PSA",              // ← uppercase
          grades: [
            {
              grade_value: 10 as any,       // ← NUMBER at runtime (TS says string)
              count: 2,
              records: [
                { title: "x", price: 100, date: "2026-06-03T00:00:00.000Z", source: "cs", url: null },
                { title: "x", price: 300, date: "2026-06-05T00:00:00.000Z", source: "cs", url: null },
              ],
            },
          ],
        },
      ],
      meta: { total_records: 2, last_sale_date: null },
    });

    const r = await serviceMod.captureOutcome(prediction, {
      horizonDays: 7,
      runId: RUN_ID,
      engineVersion: ENGINE_VERSION,
      now: T_NOW,
    });

    // CRITICAL: this must NOT silently land as no_sales_in_window from
    // format mismatch. The normalization layer must bridge the drift.
    expect(r.outcomeSource).toBe("cardsight_graded_window");
    expect(r.nSalesInWindow).toBe(2);
    expect(r.realizedOutcomePrice).toBe(200); // median of [100, 300]
    expect(r.terminal).toBe(true);
  });

  it("normalizeCompany: trims + lowercases; returns null on empty/null", () => {
    expect(serviceMod.normalizeCompany("PSA")).toBe("psa");
    expect(serviceMod.normalizeCompany("  PSA  ")).toBe("psa");
    expect(serviceMod.normalizeCompany("psa")).toBe("psa");
    expect(serviceMod.normalizeCompany(null)).toBeNull();
    expect(serviceMod.normalizeCompany("")).toBeNull();
    expect(serviceMod.normalizeCompany("   ")).toBeNull();
  });

  it("normalizeGrade: numeric canonical for whole + half grades + format drift", () => {
    // All these forms collapse to the same canonical key.
    expect(serviceMod.normalizeGrade(10)).toBe("10");
    expect(serviceMod.normalizeGrade("10")).toBe("10");
    expect(serviceMod.normalizeGrade("10.0")).toBe("10");
    expect(serviceMod.normalizeGrade("10.00")).toBe("10");
    expect(serviceMod.normalizeGrade(" 10 ")).toBe("10");
    // Half-grades:
    expect(serviceMod.normalizeGrade(9.5)).toBe("9.5");
    expect(serviceMod.normalizeGrade("9.5")).toBe("9.5");
    expect(serviceMod.normalizeGrade("9.50")).toBe("9.5");
    // Non-numeric qualifiers fall through to lowercase string match —
    // qualifier variations stay correctly distinct from base grades.
    expect(serviceMod.normalizeGrade("10 OC")).toBe("10 oc");
    expect(serviceMod.normalizeGrade("Authentic")).toBe("authentic");
    // Nullish:
    expect(serviceMod.normalizeGrade(null)).toBeNull();
    expect(serviceMod.normalizeGrade("")).toBeNull();
  });
});

describe("findCandidates — ingestion buffer", () => {
  it("a prediction at T where now=T+7 (buffer not elapsed) is NOT a candidate", async () => {
    // T = 2026-06-13, now = 2026-06-20 -> exactly 7d later
    const prediction = makePrediction({
      id: "p-buf-no",
      timestamp: "2026-06-13T12:00:00.000Z",
    });
    serviceMod._seedPredictionForTests(prediction);
    const candidates = await serviceMod.findCandidates({
      horizonDays: 7,
      ingestionBufferDays: 2,
      now: T_NOW, // 2026-06-20 12:00 UTC
    });
    expect(candidates.find((p: any) => p.id === "p-buf-no")).toBeUndefined();
  });

  it("a prediction at T where now >= T+7+2 days IS a candidate", async () => {
    // 9 days before T_NOW.
    const prediction = makePrediction({
      id: "p-buf-yes",
      timestamp: "2026-06-11T12:00:00.000Z",
    });
    serviceMod._seedPredictionForTests(prediction);
    const candidates = await serviceMod.findCandidates({
      horizonDays: 7,
      ingestionBufferDays: 2,
      now: T_NOW,
    });
    expect(candidates.find((p: any) => p.id === "p-buf-yes")).toBeDefined();
  });

  it("joinable=false is excluded from candidates", async () => {
    const prediction = makePrediction({
      id: "p-unjoinable",
      timestamp: "2026-06-01T00:00:00.000Z",
      joinable: false,
    });
    serviceMod._seedPredictionForTests(prediction);
    const candidates = await serviceMod.findCandidates({
      horizonDays: 7,
      ingestionBufferDays: 2,
      now: T_NOW,
    });
    expect(candidates.find((p: any) => p.id === "p-unjoinable")).toBeUndefined();
  });
});

/**
 * CF-TREND-EXTRAPOLATED (2026-06-10) — training-exclusion structural test.
 *
 * Asserts that:
 *   1. A trend-extrapolated emit (estimateSource="trend-extrapolated")
 *      with fairMarketValue=null produces a corpus row where
 *      fairMarketValue is null → trainingDatasetJoin's realizedReturn
 *      formula returns null for the row → row contributes nothing as
 *      observed.
 *   2. The defensive invariant check fires (and forces fmv to null in
 *      the emit payload) if a future refactor accidentally routes the
 *      estimate into fairMarketValue.
 *
 * Mocks writePredictionLog at the module boundary so we can inspect
 * the exact payload that would land in Cosmos.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { writePredictionLogMock } = vi.hoisted(() => ({
  writePredictionLogMock: vi.fn(),
}));

vi.mock("../src/services/compiq/predictionCorpus.service.js", () => ({
  writePredictionLog: writePredictionLogMock,
}));

import { emitPredictionToCorpus } from "../src/services/compiq/compiqEstimate.service";

const BASE_PARAMS = {
  cardIdentity: { card_id: "test-card" },
  body: { playerName: "Test", cardYear: 2024, product: "Bowman Draft" },
  fmvMechanism: "unavailable" as const,
  predictedPrice: null,
  predictedPriceRange: null,
  predictedPriceMechanism: "unavailable" as const,
  trendIQ: null,
  compsUsed: 0,
  callContext: {
    source: "compiq-price-by-id" as const,
    userId: null,
    holdingId: null,
    routedFromHolding: false,
  },
};

function lastEmittedPayload(): any {
  expect(writePredictionLogMock).toHaveBeenCalled();
  return writePredictionLogMock.mock.calls[writePredictionLogMock.mock.calls.length - 1][0];
}

describe("emitPredictionToCorpus — trend-extrapolated training-exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("estimateSource=trend-extrapolated + fairMarketValue=null → row's fairMarketValue stays null", () => {
    emitPredictionToCorpus({
      ...BASE_PARAMS,
      fairMarketValue: null,
      estimateSource: "trend-extrapolated",
      estimatedValue: 120,
    });
    const row = lastEmittedPayload();
    expect(row.fairMarketValue).toBeNull();
    expect(row.estimateSource).toBe("trend-extrapolated");
    expect(row.estimatedValue).toBe(120);
    // surfacedPriceSource is "none" because both predicted + fmv are null
    expect(row.surfacedPriceSource).toBe("none");
  });

  it("estimateSource=observed + numeric fairMarketValue → row carries fmv (training-eligible)", () => {
    emitPredictionToCorpus({
      ...BASE_PARAMS,
      fairMarketValue: 250,
      fmvMechanism: "main-pipeline",
      estimateSource: "observed",
    });
    const row = lastEmittedPayload();
    expect(row.fairMarketValue).toBe(250);
    expect(row.estimateSource).toBe("observed");
    expect(row.surfacedPriceSource).toBe("fairMarketValue");
  });

  it("estimateSource=last-sale + fairMarketValue=null → row's fairMarketValue stays null", () => {
    emitPredictionToCorpus({
      ...BASE_PARAMS,
      fairMarketValue: null,
      estimateSource: "last-sale",
    });
    const row = lastEmittedPayload();
    expect(row.fairMarketValue).toBeNull();
    expect(row.estimateSource).toBe("last-sale");
  });

  it("INVARIANT GUARD: estimateSource=trend-extrapolated with non-null fmv → fmv FORCED null on the row", () => {
    // A future refactor accidentally routes the estimate into fmv.
    // The defensive guard inside emitPredictionToCorpus should override
    // and emit fairMarketValue=null + log an error.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    emitPredictionToCorpus({
      ...BASE_PARAMS,
      fairMarketValue: 120, // ← would-be invariant violation
      estimateSource: "trend-extrapolated",
      estimatedValue: 120,
    });
    const row = lastEmittedPayload();
    expect(row.fairMarketValue).toBeNull(); // ← forced null by the guard
    expect(row.estimateSource).toBe("trend-extrapolated");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("INVARIANT VIOLATION"));
    errSpy.mockRestore();
  });

  it("estimateSource omitted (legacy callers) → row gets null estimateSource", () => {
    emitPredictionToCorpus({
      ...BASE_PARAMS,
      fairMarketValue: 100,
      fmvMechanism: "main-pipeline",
    });
    const row = lastEmittedPayload();
    expect(row.estimateSource).toBeNull();
    expect(row.fairMarketValue).toBe(100);
  });
});

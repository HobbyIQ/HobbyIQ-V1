// CF-CH-FMV-CROSS-VALIDATE (2026-06-28) — pins the fmv_drift_observed
// telemetry event shape and the conditions under which it fires.
//
// PRIOR-CF GAP: we had no signal-driven way to know whether our engine's
// composed FMV agreed with CardHedge's reference numbers. Without
// telemetry there's no evidence base to drive calibration decisions.
//
// THIS FILE PINS:
//   1. Both CH signals present + non-zero engine FMV → both ratios computed
//   2. Only one CH signal present → only its ratio is set, other is null
//   3. Engine FMV null/zero → both ratios null but event still fires
//   4. Both CH signals null → event SKIPPED entirely (nothing to compare)
//   5. Ratios are stable to 3 decimal places
//   6. Console.log emits a JSON-parseable line with the documented event
//      schema (KQL downstream depends on it)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logFmvDriftObserved } from "../src/services/compiq/compiqEstimate.service.js";

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

function lastEvent(): Record<string, unknown> | null {
  if (logSpy.mock.calls.length === 0) return null;
  const last = logSpy.mock.calls[logSpy.mock.calls.length - 1]?.[0];
  if (typeof last !== "string") return null;
  try {
    return JSON.parse(last) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe("logFmvDriftObserved — both CH signals present", () => {
  it("emits event with both ratios when engine FMV + both CH signals are present", () => {
    logFmvDriftObserved({
      source: "compiq.price-by-id",
      player: "Nick Kurtz",
      cardId: "1736804710503x733182095750814300",
      gradingCompany: "PSA",
      grade: "PSA 10",
      engineFmv: 2500,
      chCardFmv: {
        price: 2173.02,
        confidence: 0.36,
        confidenceGrade: "C",
        freshnessDays: 300,
        method: "direct_indexed",
      },
      chPriceEstimate: {
        price: 2896.39,
        confidence: 0.029,
        method: "direct_adjusted",
      },
    });

    const e = lastEvent();
    expect(e).not.toBeNull();
    expect(e!.event).toBe("fmv_drift_observed");
    expect(e!.source).toBe("compiq.price-by-id");
    expect(e!.player).toBe("Nick Kurtz");
    expect(e!.cardId).toBe("1736804710503x733182095750814300");
    expect(e!.grade).toBe("PSA 10");
    expect(e!.engineFmv).toBe(2500);
    // 2500 / 2173.02 = 1.150
    expect(e!.cardFmvRatio).toBe(1.15);
    // 2500 / 2896.39 = 0.863
    expect(e!.priceEstRatio).toBe(0.863);
    expect((e!.chCardFmv as any).confidenceGrade).toBe("C");
  });

  it("ratios stable to 3 decimal places (no float jitter)", () => {
    logFmvDriftObserved({
      source: "test",
      player: null,
      cardId: "card-1",
      gradingCompany: null,
      grade: "Raw",
      engineFmv: 100,
      chCardFmv: {
        price: 300,
        confidence: null,
        confidenceGrade: null,
        freshnessDays: null,
        method: null,
      },
      chPriceEstimate: null,
    });
    const e = lastEvent();
    // 100 / 300 = 0.3333... → rounded to 0.333
    expect(e!.cardFmvRatio).toBe(0.333);
  });
});

describe("logFmvDriftObserved — partial CH signals", () => {
  it("only card-fmv → only cardFmvRatio populated", () => {
    logFmvDriftObserved({
      source: "test",
      player: null,
      cardId: "card-1",
      gradingCompany: null,
      grade: "Raw",
      engineFmv: 150,
      chCardFmv: {
        price: 200,
        confidence: 0.5,
        confidenceGrade: "B",
        freshnessDays: 30,
        method: "anchor_multiplier",
      },
      chPriceEstimate: null,
    });
    const e = lastEvent();
    expect(e!.cardFmvRatio).toBe(0.75);
    expect(e!.priceEstRatio).toBeNull();
    expect(e!.chPriceEstimate).toBeNull();
  });

  it("only price-estimate → only priceEstRatio populated", () => {
    logFmvDriftObserved({
      source: "test",
      player: null,
      cardId: "card-1",
      gradingCompany: null,
      grade: "Raw",
      engineFmv: 150,
      chCardFmv: null,
      chPriceEstimate: {
        price: 100,
        confidence: 0.1,
        method: "direct",
      },
    });
    const e = lastEvent();
    expect(e!.cardFmvRatio).toBeNull();
    expect(e!.priceEstRatio).toBe(1.5);
  });
});

describe("logFmvDriftObserved — null/zero engine FMV", () => {
  it("engineFmv null → event fires but both ratios null", () => {
    logFmvDriftObserved({
      source: "test",
      player: null,
      cardId: "card-1",
      gradingCompany: null,
      grade: "Raw",
      engineFmv: null,
      chCardFmv: {
        price: 100,
        confidence: 1.0,
        confidenceGrade: "A",
        freshnessDays: 1,
        method: "x",
      },
      chPriceEstimate: {
        price: 100,
        confidence: 1.0,
        method: "x",
      },
    });
    const e = lastEvent();
    expect(e).not.toBeNull();
    expect(e!.engineFmv).toBeNull();
    expect(e!.cardFmvRatio).toBeNull();
    expect(e!.priceEstRatio).toBeNull();
  });

  it("engineFmv zero → engineFmv normalized to null in payload", () => {
    logFmvDriftObserved({
      source: "test",
      player: null,
      cardId: "card-1",
      gradingCompany: null,
      grade: "Raw",
      engineFmv: 0,
      chCardFmv: {
        price: 100,
        confidence: 1.0,
        confidenceGrade: "A",
        freshnessDays: 1,
        method: "x",
      },
      chPriceEstimate: null,
    });
    const e = lastEvent();
    expect(e!.engineFmv).toBeNull();
    expect(e!.cardFmvRatio).toBeNull();
  });
});

describe("logFmvDriftObserved — skip conditions", () => {
  it("both CH signals null → event NOT emitted at all", () => {
    logFmvDriftObserved({
      source: "test",
      player: null,
      cardId: "card-1",
      gradingCompany: null,
      grade: "Raw",
      engineFmv: 100,
      chCardFmv: null,
      chPriceEstimate: null,
    });
    expect(lastEvent()).toBeNull();
  });
});

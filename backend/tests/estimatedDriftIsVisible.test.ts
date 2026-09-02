/**
 * CF-AN-ESTIMATE-DRIFTS-IN-THE-DARK (2026-09-01).
 *
 * appendPriceHistory fired only when valuationStatus === "observed", so
 * estimated rows (the grade-curve lane) had no record at all and drifted
 * invisibly: Verlander 96.34 -> 64.12 -> 96.34 and Judge 131.88 -> 106 ->
 * 131.88 across a single day's crons.
 *
 * Estimated writes now append TAGGED. The observed-only guarantee every
 * existing reader depends on is preserved by observedPricePoints(), and by
 * absence meaning observed: every point written before the tag existed was
 * observed by construction, because the append was gated on it.
 *
 * The readers of priceHistory, all checked:
 *   backend  getHoldingPriceHistory   -> observed by default, ?includeEstimated=true opts in
 *   backend  buildCalibrationReport   -> observedPricePoints (scores prediction vs real sale)
 *   backend  buildWeeklyNarrative     -> observedPricePoints (reports market moves)
 *   iOS      PortfolioPricePoint      -> decodes { at, value, source }; unchanged by default
 *   web      HoldingPricePoint        -> same shape; field added as optional
 */
import { describe, it, expect } from "vitest";
import { observedPricePoints } from "../src/services/portfolioiq/portfolioStore.service.js";

describe("observedPricePoints — absence means observed", () => {
  it("keeps untagged points: every pre-existing point was observed by construction", () => {
    const legacy = [
      { at: "2026-08-01T00:00:00.000Z", value: 100, source: "scheduled-reprice" },
      { at: "2026-08-02T00:00:00.000Z", value: 110, source: "scheduled-reprice" },
    ];
    expect(observedPricePoints(legacy)).toEqual(legacy);
  });

  it("keeps explicitly observed points and drops estimated ones", () => {
    const mixed = [
      { at: "2026-08-01T00:00:00.000Z", value: 100 },
      { at: "2026-08-02T00:00:00.000Z", value: 96.34, valuationStatus: "estimated" as const },
      { at: "2026-08-03T00:00:00.000Z", value: 120, valuationStatus: "observed" as const },
      { at: "2026-08-04T00:00:00.000Z", value: 64.12, valuationStatus: "estimated" as const },
    ];
    expect(observedPricePoints(mixed).map((p) => p.value)).toEqual([100, 120]);
  });

  it("the Verlander / Judge drift is entirely filtered from the observed trail", () => {
    // What the grade-curve lane now records for these two holdings.
    const verlander = [96.34, 64.12, 96.34].map((value, i) => ({
      at: `2026-08-30T0${i * 6}:00:00.000Z`, value, valuationStatus: "estimated" as const,
    }));
    const judge = [131.88, 106, 131.88].map((value, i) => ({
      at: `2026-08-30T0${i * 6}:00:00.000Z`, value, valuationStatus: "estimated" as const,
    }));
    // Visible as a series...
    expect(verlander).toHaveLength(3);
    expect(judge).toHaveLength(3);
    // ...and invisible to every consumer of the observed trail.
    expect(observedPricePoints(verlander)).toEqual([]);
    expect(observedPricePoints(judge)).toEqual([]);
  });

  it("an unknown status is not silently treated as observed", () => {
    const points = [{ at: "2026-08-01T00:00:00.000Z", value: 5, valuationStatus: "pending" }];
    expect(observedPricePoints(points)).toEqual([]);
  });
});

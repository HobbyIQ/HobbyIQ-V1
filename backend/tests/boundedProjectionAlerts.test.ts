// CF-TRAJECTORY-12WK bounds (Drew, 2026-07-28). Pins the accumulator's
// contract: record → drain empties → peek reads without draining.

import { describe, expect, it, beforeEach } from "vitest";
import {
  drainAlerts,
  drainDivergenceAlerts,
  peekAlerts,
  peekDivergenceAlerts,
  recordBoundedProjectionAlert,
  recordCostBasisDivergenceIfNoteworthy,
} from "../src/services/compiq/boundedProjectionAlerts.service.js";

describe("boundedProjectionAlerts accumulator", () => {
  beforeEach(() => {
    // Wipe state between tests
    drainAlerts();
  });

  it("records + drains + resets", () => {
    expect(peekAlerts()).toHaveLength(0);
    recordBoundedProjectionAlert({
      source: "test",
      playerName: "Test Player",
      cardId: "c1",
      rate: 0.10,
      weeksSinceSale: 12,
      rawMultiplier: 2.2,
      bounded: 3.0,
      direction: "capped-ceiling",
    });
    expect(peekAlerts()).toHaveLength(1);
    const drained = drainAlerts();
    expect(drained).toHaveLength(1);
    expect(drained[0].direction).toBe("capped-ceiling");
    expect(peekAlerts()).toHaveLength(0);
  });

  it("stamps observedAt on record", () => {
    recordBoundedProjectionAlert({
      source: "test",
      playerName: null,
      rate: -0.10,
      weeksSinceSale: 12,
      rawMultiplier: -0.20,
      bounded: 0.20,
      direction: "capped-floor",
    });
    const [alert] = drainAlerts();
    expect(alert.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accumulates multiple hits across sources", () => {
    for (let i = 0; i < 5; i++) {
      recordBoundedProjectionAlert({
        source: i % 2 === 0 ? "sibling" : "observedGradeCurve",
        playerName: `p${i}`,
        rate: 0.10,
        weeksSinceSale: 12,
        rawMultiplier: 2.2,
        bounded: 3.0,
        direction: "capped-ceiling",
      });
    }
    expect(drainAlerts()).toHaveLength(5);
  });
});

// CF-COST-BASIS-DIVERGENCE-ALERT (Drew, 2026-07-28). Pins the
// >40% AND >$500 threshold and the gainLossPct derivation.
describe("recordCostBasisDivergenceIfNoteworthy", () => {
  beforeEach(() => { drainDivergenceAlerts(); });

  const base = {
    userId: "user-1",
    holdingId: "h-1",
    cardTitle: "Hartman Gold Refractor Auto",
    playerName: "Eric Hartman",
    slug: "hiq:baseball:2026:bowman:cpa-eha:gold-refractor:auto",
    // CF-DIGEST-IS-FOR-MARKET-MOVES (#1342): the digest admits exact-pool
    // prices only. The recording cases below are market moves priced by the
    // unified exact-identity engine; the fallback-rung case is asserted
    // suppressed in divergenceDigestGate.test.ts.
    fmvMethod: "unified-market-value",
    fmvBasisNote: "unified: window=180d median=$300 marketValue=$339 predicted=$330 trend=down -2.1%/wk conf=0.71",
    fmvCompCount: 2,
  } as const;

  it("Hartman real repro (85% loss, $2325 → $339) → recorded", () => {
    const recorded = recordCostBasisDivergenceIfNoteworthy({
      ...base, costBasis: 2325, fmv: 339,
    });
    expect(recorded).toBe(true);
    const [alert] = drainDivergenceAlerts();
    expect(alert.userId).toBe("user-1");
    expect(alert.gainLossPct).toBeCloseTo(-0.854, 2);
    expect(alert.costBasis).toBe(2325);
    expect(alert.fmv).toBe(339);
  });

  it("in-band divergence (<40%) → not recorded", () => {
    const recorded = recordCostBasisDivergenceIfNoteworthy({
      ...base, costBasis: 1000, fmv: 750,  // -25%
    });
    expect(recorded).toBe(false);
    expect(peekDivergenceAlerts()).toHaveLength(0);
  });

  it("high-% but low-dollar (<$500 delta) → not recorded (small holdings are noisy)", () => {
    const recorded = recordCostBasisDivergenceIfNoteworthy({
      ...base, costBasis: 100, fmv: 40,  // -60% but only $60 delta
    });
    expect(recorded).toBe(false);
    expect(peekDivergenceAlerts()).toHaveLength(0);
  });

  it("large gain (like a moonshot) also flagged", () => {
    const recorded = recordCostBasisDivergenceIfNoteworthy({
      ...base, costBasis: 500, fmv: 5000,  // +900%
    });
    expect(recorded).toBe(true);
    const [alert] = drainDivergenceAlerts();
    expect(alert.gainLossPct).toBeCloseTo(9, 1);
  });

  it("zero or non-finite cost → silently skipped", () => {
    expect(recordCostBasisDivergenceIfNoteworthy({ ...base, costBasis: 0, fmv: 500 })).toBe(false);
    expect(recordCostBasisDivergenceIfNoteworthy({ ...base, costBasis: NaN, fmv: 500 })).toBe(false);
    expect(peekDivergenceAlerts()).toHaveLength(0);
  });

  it("zero or non-finite fmv → silently skipped", () => {
    expect(recordCostBasisDivergenceIfNoteworthy({ ...base, costBasis: 1000, fmv: 0 })).toBe(false);
    expect(recordCostBasisDivergenceIfNoteworthy({ ...base, costBasis: 1000, fmv: NaN })).toBe(false);
    expect(peekDivergenceAlerts()).toHaveLength(0);
  });

  it("independent from bounded-projection alerts (separate accumulators)", () => {
    recordCostBasisDivergenceIfNoteworthy({ ...base, costBasis: 2325, fmv: 339 });
    recordBoundedProjectionAlert({
      source: "test", playerName: null, rate: 0.10, weeksSinceSale: 12,
      rawMultiplier: 2.2, bounded: 3.0, direction: "capped-ceiling",
    });
    expect(peekDivergenceAlerts()).toHaveLength(1);
    expect(peekAlerts()).toHaveLength(1);
    expect(drainDivergenceAlerts()).toHaveLength(1);
    expect(peekAlerts()).toHaveLength(1);  // bounded alerts untouched
    expect(drainAlerts()).toHaveLength(1);
  });
});

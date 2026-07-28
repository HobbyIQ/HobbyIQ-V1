// CF-TRAJECTORY-12WK bounds (Drew, 2026-07-28). Pins the accumulator's
// contract: record → drain empties → peek reads without draining.

import { describe, expect, it, beforeEach } from "vitest";
import {
  drainAlerts,
  peekAlerts,
  recordBoundedProjectionAlert,
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

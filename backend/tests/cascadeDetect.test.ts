// CF-CASCADE-ALERTS (Drew, 2026-07-17). Pinning tests.

import { describe, it, expect } from "vitest";
import {
  detectCascades,
  detectOne,
  _DEFAULTS,
} from "../src/services/portfolioiq/cascadeDetect.service.js";
import type { CascadeDetectionInput } from "../src/types/cascadeAlert.types.js";

const NOW = new Date("2026-07-17T12:00:00Z");
const DETECTED_AT = NOW.toISOString();

function mk(overrides: Partial<CascadeDetectionInput> = {}): CascadeDetectionInput {
  return {
    player: "Test Player",
    raw: { momentum: 1.0, direction: "flat", qualifyingCards: 5, velocityPerWeek: 20 },
    graded: { momentum: 1.0, direction: "flat", qualifyingCards: 5, velocityPerWeek: 10 },
    computedAt: "2026-07-17T03:45:00Z",
    ...overrides,
  };
}

describe("detectOne — negative cases", () => {
  const opts = { ..._DEFAULTS };

  it("returns null when raw is missing", () => {
    expect(detectOne(mk({ raw: null }), opts, DETECTED_AT)).toBeNull();
  });

  it("returns null when graded is missing", () => {
    expect(detectOne(mk({ graded: null }), opts, DETECTED_AT)).toBeNull();
  });

  it("returns null when raw qualifyingCards < min", () => {
    expect(detectOne(mk({
      raw: { momentum: 1.0, direction: "flat", qualifyingCards: 2, velocityPerWeek: 5 },
      graded: { momentum: 1.5, direction: "up", qualifyingCards: 5, velocityPerWeek: 3 },
    }), opts, DETECTED_AT)).toBeNull();
  });

  it("returns null when graded direction is not up", () => {
    expect(detectOne(mk({
      graded: { momentum: 1.5, direction: "flat", qualifyingCards: 5, velocityPerWeek: 3 },
    }), opts, DETECTED_AT)).toBeNull();
  });

  it("returns null when graded.momentum below minGradedMomentum", () => {
    expect(detectOne(mk({
      raw: { momentum: 1.0, direction: "flat", qualifyingCards: 5, velocityPerWeek: 20 },
      graded: { momentum: 1.05, direction: "up", qualifyingCards: 5, velocityPerWeek: 3 },
    }), opts, DETECTED_AT)).toBeNull();
  });

  it("returns null when momentum ratio below threshold", () => {
    // graded 1.15, raw 1.10 → ratio 1.045 < 1.15
    expect(detectOne(mk({
      raw: { momentum: 1.10, direction: "up", qualifyingCards: 5, velocityPerWeek: 20 },
      graded: { momentum: 1.15, direction: "up", qualifyingCards: 5, velocityPerWeek: 3 },
    }), opts, DETECTED_AT)).toBeNull();
  });
});

describe("detectOne — severity classification", () => {
  const opts = { ..._DEFAULTS };

  it("insider severity when raw is flat and graded is up", () => {
    const ev = detectOne(mk({
      raw: { momentum: 1.0, direction: "flat", qualifyingCards: 5, velocityPerWeek: 20 },
      graded: { momentum: 1.20, direction: "up", qualifyingCards: 5, velocityPerWeek: 3 },
    }), opts, DETECTED_AT);
    expect(ev).not.toBeNull();
    expect(ev!.severity).toBe("insider");
    expect(ev!.reason).toContain("insider signal");
  });

  it("insider severity when raw is down and graded is up", () => {
    const ev = detectOne(mk({
      raw: { momentum: 0.9, direction: "down", qualifyingCards: 5, velocityPerWeek: 20 },
      graded: { momentum: 1.20, direction: "up", qualifyingCards: 5, velocityPerWeek: 3 },
    }), opts, DETECTED_AT);
    expect(ev).not.toBeNull();
    expect(ev!.severity).toBe("insider");
  });

  it("emerging severity: raw up AND graded ≥ 1.3× raw", () => {
    const ev = detectOne(mk({
      raw: { momentum: 1.10, direction: "up", qualifyingCards: 5, velocityPerWeek: 20 },
      graded: { momentum: 1.50, direction: "up", qualifyingCards: 5, velocityPerWeek: 3 },
    }), opts, DETECTED_AT);
    // ratio = 1.5/1.1 = 1.363, >= 1.3
    expect(ev).not.toBeNull();
    expect(ev!.severity).toBe("emerging");
  });

  it("confirmed severity: both up, graded leading but ratio < 1.3", () => {
    const ev = detectOne(mk({
      raw: { momentum: 1.10, direction: "up", qualifyingCards: 5, velocityPerWeek: 20 },
      graded: { momentum: 1.30, direction: "up", qualifyingCards: 5, velocityPerWeek: 3 },
    }), opts, DETECTED_AT);
    // ratio = 1.3/1.1 = 1.181, in [1.15, 1.3)
    expect(ev).not.toBeNull();
    expect(ev!.severity).toBe("confirmed");
  });
});

describe("detectOne — payload shape", () => {
  it("emits playerSlug, momentumRatio, all counts", () => {
    const ev = detectOne(mk({
      player: "Ken Griffey Jr.",
      raw: { momentum: 1.00, direction: "flat", qualifyingCards: 7, velocityPerWeek: 20 },
      graded: { momentum: 1.30, direction: "up", qualifyingCards: 4, velocityPerWeek: 3 },
      computedAt: "2026-07-17T03:45:00Z",
    }), _DEFAULTS, DETECTED_AT);
    expect(ev).not.toBeNull();
    expect(ev!.player).toBe("Ken Griffey Jr.");
    expect(ev!.playerSlug).toBe("ken_griffey_jr");
    expect(ev!.detectionInput.momentumRatio).toBeCloseTo(1.3, 2);
    expect(ev!.detectionInput.rawQualifyingCards).toBe(7);
    expect(ev!.detectionInput.gradedQualifyingCards).toBe(4);
    expect(ev!.detectionInput.gradedDirection).toBe("up");
    expect(ev!.detectionInput.playerTrendComputedAt).toBe("2026-07-17T03:45:00Z");
  });
});

describe("detectCascades — batch", () => {
  it("returns events sorted by momentumRatio DESC", () => {
    const inputs: CascadeDetectionInput[] = [
      mk({
        player: "A",
        raw: { momentum: 1.10, direction: "up", qualifyingCards: 5, velocityPerWeek: 20 },
        graded: { momentum: 1.35, direction: "up", qualifyingCards: 5, velocityPerWeek: 3 },
      }),
      mk({
        player: "B",
        raw: { momentum: 1.00, direction: "flat", qualifyingCards: 5, velocityPerWeek: 20 },
        graded: { momentum: 1.60, direction: "up", qualifyingCards: 5, velocityPerWeek: 3 },
      }),
      mk({
        player: "C",
        raw: { momentum: 1.05, direction: "up", qualifyingCards: 5, velocityPerWeek: 20 },
        graded: { momentum: 1.25, direction: "up", qualifyingCards: 5, velocityPerWeek: 3 },
      }),
    ];
    const r = detectCascades(inputs, {}, NOW);
    expect(r.detected).toBe(3);
    // Ratios: A=1.227, B=1.60, C=1.190. Sorted DESC: B, A, C.
    expect(r.events.map((e) => e.player)).toEqual(["B", "A", "C"]);
  });

  it("skips inputs that don't fire", () => {
    const inputs: CascadeDetectionInput[] = [
      mk({ player: "Fires", raw: null }),
      mk({
        player: "Passes",
        raw: { momentum: 1.0, direction: "flat", qualifyingCards: 5, velocityPerWeek: 20 },
        graded: { momentum: 1.50, direction: "up", qualifyingCards: 5, velocityPerWeek: 3 },
      }),
    ];
    const r = detectCascades(inputs, {}, NOW);
    expect(r.scanned).toBe(2);
    expect(r.detected).toBe(1);
    expect(r.events[0].player).toBe("Passes");
  });

  it("pins default thresholds", () => {
    expect(_DEFAULTS.minMomentumRatio).toBe(1.15);
    expect(_DEFAULTS.minGradedMomentum).toBe(1.10);
    expect(_DEFAULTS.minQualifyingCardsPerVariant).toBe(3);
  });
});

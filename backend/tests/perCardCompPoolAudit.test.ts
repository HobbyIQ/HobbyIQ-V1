// CF-PER-CARD-COMP-POOL-AUDIT (2026-06-29) — pins the grade-string
// composition used by the engine's per-card audit telemetry. The audit
// fires after every pricing emission and compares engine FMV to CH's
// reference FMV for the same (chCardId, grade). Class D from the
// 2026-06-29 volume test surfaced engine ≈ CH ± 50% drift cases
// (Bryant, Arenado) — this audit captures those events with enough
// context for offline diagnosis.
//
// THIS FILE PINS:
//   1. (PSA, 10) → "PSA 10"
//   2. (BGS, 9.5) → "BGS 9.5"
//   3. (SGC, 9) → "SGC 9"
//   4. ("PSA", "raw") → "Raw" (raw-marker on the value side)
//   5. (null/null) → "Raw" (engine treats unspecified as raw)
//   6. ("Raw", null) → "Raw"
//   7. ("PSA", null) → null (incomplete grade, audit skipped)
//   8. ("PSA", 11) → null (out-of-range grade value, audit skipped)
//   9. ("UNKNOWN", 10) → null (unrecognized company)
//   10. ("psa", 10) → "PSA 10" (case-insensitive company)
//
// CH expects exactly one of: "Raw", "PSA <0-10>", "BGS <0-10>",
// "SGC <0-10>", "CGC <0-10>", "HGA <0-10>" (with optional .5 step).
// Anything else fails the getCardFmv lookup and silently drops the
// audit row — preferable to noise.

import { describe, expect, it } from "vitest";
import { formatGradeForCardHedge } from "../src/services/compiq/compiqEstimate.service.js";

describe("CF-PER-CARD-COMP-POOL-AUDIT — formatGradeForCardHedge", () => {
  it("PSA 10 → 'PSA 10'", () => {
    expect(formatGradeForCardHedge("PSA", 10)).toBe("PSA 10");
  });

  it("BGS 9.5 → 'BGS 9.5'", () => {
    expect(formatGradeForCardHedge("BGS", 9.5)).toBe("BGS 9.5");
  });

  it("SGC 9 → 'SGC 9'", () => {
    expect(formatGradeForCardHedge("SGC", 9)).toBe("SGC 9");
  });

  it("CGC 10 → 'CGC 10'", () => {
    expect(formatGradeForCardHedge("CGC", 10)).toBe("CGC 10");
  });

  it("HGA 10 → 'HGA 10'", () => {
    expect(formatGradeForCardHedge("HGA", 10)).toBe("HGA 10");
  });

  it("(any, 'raw') → 'Raw'", () => {
    expect(formatGradeForCardHedge("PSA", "raw")).toBe("Raw");
  });

  it("(null, null) → 'Raw' (engine default)", () => {
    expect(formatGradeForCardHedge(null, null)).toBe("Raw");
  });

  it("('Raw', null) → 'Raw'", () => {
    expect(formatGradeForCardHedge("Raw", null)).toBe("Raw");
  });

  it("(PSA, null) → null (incomplete grade pair, audit skipped)", () => {
    expect(formatGradeForCardHedge("PSA", null)).toBe(null);
  });

  it("(PSA, 11) → null (out-of-range grade value, audit skipped)", () => {
    expect(formatGradeForCardHedge("PSA", 11)).toBe(null);
  });

  it("('UNKNOWN', 10) → null (unrecognized company, audit skipped)", () => {
    expect(formatGradeForCardHedge("UNKNOWN", 10)).toBe(null);
  });

  it("('psa', 10) → 'PSA 10' (case-insensitive company normalization)", () => {
    expect(formatGradeForCardHedge("psa", 10)).toBe("PSA 10");
  });

  it("(PSA, '10') → 'PSA 10' (string grade value)", () => {
    expect(formatGradeForCardHedge("PSA", "10")).toBe("PSA 10");
  });

  it("(PSA, '8.5') → 'PSA 8.5' (half-grade string)", () => {
    expect(formatGradeForCardHedge("PSA", "8.5")).toBe("PSA 8.5");
  });

  it("(PSA, 8.5) → 'PSA 8.5' (half-grade numeric)", () => {
    expect(formatGradeForCardHedge("PSA", 8.5)).toBe("PSA 8.5");
  });

  it("(PSA, 'abc') → null (non-numeric value rejected)", () => {
    expect(formatGradeForCardHedge("PSA", "abc")).toBe(null);
  });

  it("(PSA, 0) → 'PSA 0' (zero is a legal grade — historical PSA 1.5/0.5 etc. exist)", () => {
    // Defensive: zero is technically out-of-band for current PSA cards,
    // but our regex doesn't reject it. CH lookup would 404, audit drops
    // the row silently — preferable to false-rejecting an edge case.
    expect(formatGradeForCardHedge("PSA", 0)).toBe("PSA 0");
  });
});

// CF-RUNG-LABEL (D4 "one valuation path", PR 1 — 2026-08-29). The rung
// vocabulary is a contract three engines write and the digest reads. These
// pin the two mapping helpers and the one predicate the gate depends on.
import { describe, it, expect } from "vitest";
import {
  isExactPoolRung,
  canonicalRungLabel,
  hobbyIqRungLabel,
} from "../src/services/compiq/fmvRung.js";

describe("isExactPoolRung — the only question the digest gate asks", () => {
  it("admits every exact-pool aggregation", () => {
    for (const l of [
      "exact-pool-projection",
      "exact-pool-last-sale",
      "exact-pool-leading-edge",
      "exact-pool-weighted-median",
      "exact-pool-median",
      "exact-pool-trajectory",
    ]) expect(isExactPoolRung(l), l).toBe(true);
  });

  it("refuses every fallback rung, and the absence of a label", () => {
    for (const l of [
      "cross-grade-fallback",
      "grade-curve-estimate",
      "sibling-parallel",
      "neighbor-parallel",
      "family-baseline",
      "grade-cross-raw",
      "rare-card-anchor",
      "no-basis",
      "",
      null,
      undefined,
      42,
    ]) expect(isExactPoolRung(l), String(l)).toBe(false);
  });
});

describe("canonicalRungLabel — canonical-fmv's method in the shared vocabulary", () => {
  it("direct-comp names the projection branch that fired", () => {
    expect(canonicalRungLabel("direct-comp", "linear-regression")).toBe("exact-pool-projection");
    expect(canonicalRungLabel("direct-comp", "trend-adjusted-last-sale")).toBe("exact-pool-last-sale");
  });

  it("direct-comp with no branch recorded (a cached pre-label result) is still the exact pool", () => {
    expect(canonicalRungLabel("direct-comp")).toBe("exact-pool-projection");
    expect(canonicalRungLabel("direct-comp", null)).toBe("exact-pool-projection");
  });

  it("every fallback method is already a rung name and passes through unchanged", () => {
    for (const m of [
      "cross-parallel", "neighbor-parallel", "sibling-parallel", "hot-raw-same-card-anchor",
      "family-baseline", "product-tier", "tiered-momentum-card", "tiered-momentum-player", "no-basis",
    ] as const) {
      expect(canonicalRungLabel(m)).toBe(m);
      expect(isExactPoolRung(canonicalRungLabel(m))).toBe(false);
    }
  });
});

describe("hobbyIqRungLabel — the our-pool ladder's method in the shared vocabulary", () => {
  it("direct-slug names the aggregation that produced the number", () => {
    expect(hobbyIqRungLabel("direct-slug", "linear-regression")).toBe("exact-pool-projection");
    expect(hobbyIqRungLabel("direct-slug", "trend-adjusted-last-sale")).toBe("exact-pool-last-sale");
    expect(hobbyIqRungLabel("direct-slug", "median")).toBe("exact-pool-median");
  });

  it("every other ladder rung passes through and is NOT exact-pool", () => {
    for (const m of [
      "cross-setkey", "cross-printrun", "same-printrun-cross-parallel", "printrun-discovery",
      "sibling-parallel", "family-baseline", "grade-cross-raw", "composite-neighbor",
      "rare-card-anchor", "no-basis",
    ] as const) {
      expect(hobbyIqRungLabel(m, "linear-regression")).toBe(m);
      expect(isExactPoolRung(hobbyIqRungLabel(m, "linear-regression"))).toBe(false);
    }
  });
});

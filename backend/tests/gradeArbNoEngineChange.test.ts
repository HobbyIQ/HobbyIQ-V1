// CF-GRADE-ARB (Drew, 2026-09-02). The structural pin: the grade-arb
// surface is READ-ONLY over the valuation engine.
//
// The whole design rests on this. If a later change makes the arb
// modules price something themselves, they become the fifth engine
// CF-ONE-VALUATION-PATH exists to prevent (D14: four routes disagreeing
// by >25% on 44.2% of cards). This test fails when that happens.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(resolve(here, "..", "src", p), "utf8");

const COMPUTE = "services/portfolioiq/gradeArbCompute.service.ts";
const ANALYZE = "services/portfolioiq/gradeArbAnalyze.service.ts";

describe("grade-arb does not change the valuation engine", () => {
  it("the pure compute module imports nothing but a type", () => {
    const text = src(COMPUTE);
    const imports = text.match(/^import .*$/gm) ?? [];
    // Exactly one import, and it is type-only: the curve entry shape.
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatch(/^import type /);
    expect(imports[0]).toContain("observedGradeCurve.service.js");
  });

  it("no arb module writes to Cosmos or mutates a holding", () => {
    for (const f of [COMPUTE, ANALYZE]) {
      const text = src(f);
      // Persistence verbs that would make this surface a writer.
      expect(text).not.toMatch(/\bupsert\b|\breplace\(|\bcreate\(|\bdelete\(/);
      expect(text).not.toMatch(/portfolioStore\.|writeUserDoc|persistHolding/);
    }
  });

  it("the arb path prices nothing itself — no median, mean, or pool read", () => {
    for (const f of [COMPUTE, ANALYZE]) {
      const text = src(f)
        // Strip comments: the modules DISCUSS medians and means at
        // length in their headers, and that prose is the point.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(text).not.toMatch(/\bmedian\b/i);
      expect(text).not.toMatch(/\bmean\(/);
      expect(text).not.toMatch(/sold_comps|ch_daily_sales|\.items\.query/);
      // The engine is consumed, never re-implemented.
      expect(text).not.toMatch(/buildObservedGradeCurve|unifiedPricing|exactPoolSupremacy/);
    }
  });

  it("the orchestrator reaches the engine only through the one entry", () => {
    const text = src(ANALYZE);
    expect(text).toContain("valueIdentity");
    expect(text).toContain("oneValuationPath.service.js");
  });

  it("GRADE_CALIBRATION is read for family classification only", () => {
    const text = src(ANALYZE);
    // classifyFamily is a pure string->family classifier. No multiplier
    // lookup: an invented or re-applied ratio is exactly the
    // empirical-only violation this surface must not commit.
    expect(text).toContain("classifyFamily");
    expect(text).not.toMatch(/lookupGradeRatio|subTierScalingForFallback|GRADE_CALIBRATION\[/);
  });

  it("the empirical gate reads the curve's own count, never the ladder", () => {
    const text = src(COMPUTE);
    // canonicalFmv's gradeLadder tiers are {grader, medianRatio, fmv}:
    // multiplication, with a placeholder sampleSize. A gate reading it
    // would be a gate reading nothing.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/gradeLadder|medianRatio|sampleSize/);
    // It reads the per-tier count and compares it to the floor.
    expect(code).toContain("sampleCount");
    expect(code).toContain("MIN_GRADED_COMPS");
  });
});

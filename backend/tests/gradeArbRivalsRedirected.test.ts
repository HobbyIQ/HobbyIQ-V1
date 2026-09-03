// CF-GRADE-ARB-UNIFY (2026-09-02). Pins that the two surfaces which used
// to price grade-arbitrage their own way now read the gated computation.
//
// Both surfaces keep their UI: /grade-analysis still answers the web
// Grade Calculator modal in the GradeWorthyAnalysis shape, and the
// nightly job still sends the same push. Only the engine moved.
//
// These are source-level pins on the wiring plus behavioural pins on the
// adapter. The wiring pins are what make the mutation ("re-wire the mean
// path back") go red.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { gradeWorthyFromArb } from "../src/services/portfolioiq/gradeWorthyAnalyze.service.js";
import {
  GRADE_ARB_DISCLOSURE,
  MIN_GRADED_COMPS,
  type GradeArbResult,
} from "../src/services/portfolioiq/gradeArbCompute.service.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(resolve(here, "../src", p), "utf8");

const MODAL_PATH = "services/portfolioiq/gradeWorthyAnalyze.service.ts";
const JOB_PATH = "services/portfolioiq/gradeArbitrageNotifyJob.service.ts";

describe("rival 1: the /grade-analysis modal path", () => {
  const s = src(MODAL_PATH);

  it("imports the gated grade-arb computation", () => {
    expect(s).toMatch(/import\s*\{\s*analyzeHoldingGradeArb\s*\}\s*from\s*"\.\/gradeArbAnalyze\.service\.js"/);
    expect(s).toContain("analyzeHoldingGradeArb(holding)");
  });

  it("no longer calls the mean-anchored engine", () => {
    // gradeWorthyCompute reads graderPremiums whose prices are
    // mean(prices) from localCompPremiums.service.ts:47.
    expect(s).not.toContain("analyzeGradeWorthy(");
    expect(s).not.toMatch(/from\s*"\.\/gradeWorthyCompute\.service\.js"/);
  });

  it("keeps the response shape the modal renders", () => {
    // The modal reads analysis.allTiers[].graderTier / expectedGain and
    // analysis.overallRecommendation. Losing any of these is a broken
    // feature, not a refactor.
    expect(s).toContain("graderTier:");
    expect(s).toContain("expectedGain:");
    expect(s).toContain("overallRecommendation");
    expect(s).toContain("failureRate");
    expect(s).toContain("diagnostics");
  });
});

describe("rival 2: the nightly grade-arb push job", () => {
  const s = src(JOB_PATH);

  it("reads the gated computation, not the multiplier ladder", () => {
    expect(s).toMatch(/import\s*\{\s*analyzeHoldingGradeArb\s*\}/);
    expect(s).toContain("analyzeHoldingGradeArb(");
  });

  it("no longer reads canonicalFmv.gradeLadder for its numbers", () => {
    expect(s).not.toContain("computeCanonicalFmv");
    // Only prose may mention the ladder now.
    const code = s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code).not.toContain("gradeLadder.tiers");
    expect(code).not.toContain("canonical.gradeLadder");
  });

  it("keeps the alert surface: title, body, cooldowns, caps", () => {
    expect(s).toContain("sendPriceAlertNotification");
    expect(s).toContain("pushTitle");
    expect(s).toContain("pushBody");
    expect(s).toContain("gradeArbNotifyLastAt");
    expect(s).toContain("perHoldingCooldownDays");
    expect(s).toContain("dismissCooldownDays");
  });
});

describe("the modal adapter renders gated numbers in the old shape", () => {
  const arb = (over: Partial<GradeArbResult> = {}): GradeArbResult => ({
    available: true,
    refusal: null,
    refusalReason: null,
    rawValue: 100,
    gradingCostUsd: 25,
    tiers: [
      {
        tier: "PSA 10", grader: "PSA", gradedValue: 520, netGain: 395,
        netGainPct: 316, sampleCount: 6, rungLabel: "exact-pool-projection",
        valueSource: "observed", confidence: 0.8,
        basis: "PSA 10: projected from 6 sales of this card at PSA 10.",
      },
    ],
    bestTier: null,
    disclosure: GRADE_ARB_DISCLOSURE,
    ...over,
  });

  it("carries the arb's dollar figures through unchanged", () => {
    const a = gradeWorthyFromArb(arb());
    expect(a.rawPrice).toBe(100);
    expect(a.allTiers).toHaveLength(1);
    expect(a.allTiers[0].graderTier).toBe("PSA 10");
    expect(a.allTiers[0].gradedMedianPrice).toBe(520);
    expect(a.allTiers[0].expectedGain).toBe(395);
    expect(a.allTiers[0].gradedSampleSize).toBe(6);
    expect(a.bestTier?.graderTier).toBe("PSA 10");
    expect(a.overallRecommendation).toBe("grade_now");
  });

  it("demotes to wait when the player's market is falling and margin is thin", () => {
    const thin = arb({
      tiers: [{
        tier: "PSA 10", grader: "PSA", gradedValue: 150, netGain: 25,
        netGainPct: 20, sampleCount: 4, rungLabel: "exact-pool-projection",
        valueSource: "observed", confidence: 0.7,
        basis: "PSA 10: projected from 4 sales of this card at PSA 10.",
      }],
    });
    expect(gradeWorthyFromArb(thin, { playerMomentumDirection: "down" }).overallRecommendation)
      .toBe("grade_worthy_but_wait");
    expect(gradeWorthyFromArb(thin, { playerMomentumDirection: "up" }).overallRecommendation)
      .toBe("grade_now");
  });

  it("reports a losing tier rather than hiding it", () => {
    const loss = arb({
      tiers: [{
        tier: "PSA 9", grader: "PSA", gradedValue: 90, netGain: -35,
        netGainPct: -28, sampleCount: 11, rungLabel: "exact-pool-projection",
        valueSource: "observed", confidence: 0.9,
        basis: "PSA 9: projected from 11 sales of this card at PSA 9.",
      }],
    });
    const a = gradeWorthyFromArb(loss);
    expect(a.allTiers[0].expectedGain).toBe(-35);
    expect(a.overallRecommendation).toBe("not_worth");
  });

  it("passes a gate refusal through as insufficient_data, keeping the counts", () => {
    const refused = arb({
      available: false,
      refusal: "no-graded-basis",
      refusalReason: "Not enough real graded sales of this card: PSA 10 has 2 graded sales (3 required). No graded outcome to show.",
      tiers: [],
    });
    const a = gradeWorthyFromArb(refused);
    expect(a.overallRecommendation).toBe("insufficient_data");
    expect(a.allTiers).toEqual([]);
    expect(a.bestTier).toBeNull();
    expect(a.reason).toContain("2 graded sales");
    expect(MIN_GRADED_COMPS).toBe(3);
  });

  it("an already-graded holding stays out of scope", () => {
    const a = gradeWorthyFromArb(arb({
      available: false, refusal: "not-raw",
      refusalReason: "Holding is already graded — grade arbitrage applies to raw cards only.",
      tiers: [], rawValue: null,
    }));
    expect(a.overallRecommendation).toBe("not_worth");
    expect(a.allTiers).toEqual([]);
  });
});

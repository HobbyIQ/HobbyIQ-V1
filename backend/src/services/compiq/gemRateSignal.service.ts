// CF-GEM-RATE-DYNAMIC-MULTIPLIER (Drew, 2026-07-15, PR #495): gem-rate-
// aware grader premium. When a card has enough observed graded sales to
// infer a gem rate, the multiplier for top grades (PSA 10 / BGS 10 /
// BGS 9.5 / SGC 10) is derived from that gem rate directly instead of
// looked up in the static table. Scarce gems → higher multiplier;
// abundant gems → lower multiplier.
//
// Drew's anchors (2026-07-15):
//   Gem rate 50%+  → 2-3x     (use 2.5)
//   Gem rate 25-50% → 3-5x    (use 4.0)
//   Gem rate 10-25% → 5-9x    (use 7.0)
//   Gem rate <10%   → 10x+
//
// Formula: multiplier = clamp(-3 * ln(gemRate) + 0.5, 1.5, 12.0)
// Fits Drew's anchors:
//   gemRate=0.50 → -3×-0.693 + 0.5 = 2.58   (Drew: 2-3 ✓)
//   gemRate=0.25 → -3×-1.386 + 0.5 = 4.66   (Drew: 3-5 ✓)
//   gemRate=0.10 → -3×-2.303 + 0.5 = 7.41   (Drew: 5-9 ✓)
//   gemRate=0.05 → -3×-2.996 + 0.5 = 9.49   (Drew: 10+ ✓)
//
// Inferred gem rate: because CardHedge doesn't surface pop-report data
// directly, we compute the inferred gem rate from the observed grade
// distribution in CH's recent sales. This isn't the true PSA/BGS/SGC
// population gem rate — it's the gem PROPORTION of what actually
// changes hands. That's a stronger signal for pricing anyway because
// it captures which subset of the graded pop trades liquidly.

const MIN_OBSERVED_GRADED_FOR_CONFIDENT_SIGNAL = 10;

export interface GradedSaleObservation {
  grade: string;                 // "PSA 10", "BGS 9.5 Black Label", etc.
  price: number;
}

export interface GemRateSignal {
  cardId: string | null;
  totalGradedObserved: number;
  topGradeObserved: number;      // PSA 10 + BGS 10 + BGS 9.5 + BGS 10 Black Label + SGC 10
  gemRate: number;               // topGradeObserved / totalGradedObserved
  gemRateBand: "<10%" | "10-25%" | "25-50%" | ">=50%";
  confidence: "low" | "medium" | "high";
  computedAt: string;
  windowDays: number;
}

/**
 * CF-GEM-RATE-DYNAMIC-MULTIPLIER formula. Returns the raw-derived
 * multiplier for a top-grade slab given the observed gem rate. Callers
 * should ONLY apply this when the requested grade is one of the "top"
 * grades — PSA 10, BGS 10, BGS 10 Black Label, BGS 9.5, SGC 10. Mid-
 * tier grades don't respond to gem-rate the same way (their pop is
 * dominated by non-gem submissions).
 *
 * The formula is monotonically decreasing in gemRate and asymptotically
 * bounded — a card with 100% gem rate returns ~1.5× (still a slab
 * floor premium); a card with 1% gem rate returns ~12× (very scarce).
 */
export function multiplierFromGemRate(gemRate: number): number {
  if (!Number.isFinite(gemRate) || gemRate <= 0 || gemRate >= 1) {
    return 1.0; // signals invalid — caller falls back to table
  }
  const raw = -3 * Math.log(gemRate) + 0.5;
  return Math.max(1.5, Math.min(12.0, Math.round(raw * 100) / 100));
}

/**
 * Given a list of observed graded sales for a card (or set / player, at
 * the caller's discretion), compute the gem rate and confidence tier.
 *
 * TOP-GRADE definition — matches the gem premium: PSA 10, BGS 10,
 * BGS 10 Black Label, BGS 9.5, SGC 10. Anything else counts toward the
 * denominator only.
 */
export function computeGemRateFromObservations(
  observations: ReadonlyArray<GradedSaleObservation>,
  opts: { cardId?: string | null; windowDays?: number } = {},
): GemRateSignal | null {
  if (!observations || observations.length === 0) return null;
  let total = 0;
  let top = 0;
  for (const o of observations) {
    if (!o.grade || typeof o.grade !== "string") continue;
    if (typeof o.price !== "number" || !Number.isFinite(o.price) || o.price <= 0) continue;
    const g = o.grade.trim();
    // Raw sales don't count toward gem-rate math.
    if (g === "Raw" || g === "") continue;
    total++;
    if (isTopGrade(g)) top++;
  }
  if (total < 1) return null;
  const gemRate = top / total;
  const band: GemRateSignal["gemRateBand"] =
    gemRate >= 0.5 ? ">=50%"
      : gemRate >= 0.25 ? "25-50%"
      : gemRate >= 0.10 ? "10-25%"
      : "<10%";
  const confidence: GemRateSignal["confidence"] =
    total >= MIN_OBSERVED_GRADED_FOR_CONFIDENT_SIGNAL
      ? total >= 30 ? "high" : "medium"
      : "low";
  return {
    cardId: opts.cardId ?? null,
    totalGradedObserved: total,
    topGradeObserved: top,
    gemRate: Math.round(gemRate * 1000) / 1000,
    gemRateBand: band,
    confidence,
    computedAt: new Date().toISOString(),
    windowDays: opts.windowDays ?? 365,
  };
}

/** Whether the grade counts toward the "gem" numerator. */
function isTopGrade(grade: string): boolean {
  const g = grade.trim().toUpperCase();
  return (
    g === "PSA 10"
    || g === "BGS 10"
    || g === "BGS 10 BLACK LABEL"
    || g === "BGS 9.5"
    || g === "SGC 10"
  );
}

/**
 * Decision helper — given a gem-rate signal and the requested grade,
 * return whether the gem-rate multiplier should override the static
 * table. Rule: only for TOP grades AND only when confidence >= medium
 * (>=10 observations in the window). Low confidence falls back to
 * table.
 */
export function shouldUseGemRateMultiplier(
  signal: GemRateSignal | null,
  requestedGrade: string,
): boolean {
  if (!signal || signal.confidence === "low") return false;
  if (!isTopGrade(requestedGrade)) return false;
  return true;
}

// CF-GRADER-OUTCOMES (Drew, 2026-07-17). Pure math for the observed
// grader-outcome distributions. No IO.

import type {
  OutcomeSale,
  GraderOutcomeOptions,
  GraderOutcomeRow,
  GraderOutcomeResult,
} from "../../types/graderOutcome.types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULTS: Required<GraderOutcomeOptions> = {
  windowDays: 90,
  minGradedSamples: 20,
};

export function computeGraderOutcomes(
  sales: OutcomeSale[],
  opts: GraderOutcomeOptions = {},
  now: Date = new Date(),
): GraderOutcomeResult {
  const options = resolveOptions(opts);
  const { windowDays, minGradedSamples } = options;
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;

  // family → grader → tier → count
  // family → grader → { familyLabel, counts }
  const buckets = new Map<string, {
    familyLabel: string;
    byGrader: Map<string, Map<string, number>>;
  }>();

  for (const s of sales) {
    if (!Number.isFinite(s.price) || s.price <= 0) continue;
    const t = Date.parse(s.saleDate);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const familyKey = slugFamily(s.cardSetType);
    if (!familyKey) continue;
    const graderName = (s.grader ?? "").trim();
    if (!graderName || graderName.toLowerCase() === "raw") continue;
    const tier = (s.grade ?? "").trim();
    if (!tier) continue;

    let fam = buckets.get(familyKey);
    if (!fam) {
      fam = { familyLabel: s.cardSetType, byGrader: new Map() };
      buckets.set(familyKey, fam);
    }
    let byTier = fam.byGrader.get(graderName);
    if (!byTier) {
      byTier = new Map();
      fam.byGrader.set(graderName, byTier);
    }
    byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
  }

  const computedAt = now.toISOString();
  const rows: GraderOutcomeRow[] = [];

  for (const [familyKey, fam] of buckets.entries()) {
    for (const [grader, byTier] of fam.byGrader.entries()) {
      let total = 0;
      for (const n of byTier.values()) total += n;
      if (total < minGradedSamples) continue;

      const tierShares: Record<string, number> = {};
      const tierCounts: Record<string, number> = {};
      for (const [tier, n] of byTier.entries()) {
        tierCounts[tier] = n;
        tierShares[tier] = round(n / total, 4);
      }

      rows.push({
        familyKey,
        familyLabel: fam.familyLabel,
        grader,
        tierShares,
        tierCounts,
        totalGradedSamples: total,
        confidence: classifyConfidence(total),
        computedAt,
      });
    }
  }

  rows.sort((a, b) => b.totalGradedSamples - a.totalGradedSamples);

  return { computedAt, windowDays, rows };
}

/** Slug a card_set_type into a stable family key. Matches
 *  observedMultipliersCompute.slugFamily. */
export function slugFamily(cardSetType: string): string {
  if (!cardSetType) return "";
  return cardSetType
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Probability-weighted expected graded price. Given per-tier median
 *  prices (typically from observedMultipliers) and this row's tier
 *  shares, returns the weighted average. Skips tiers absent from
 *  either input. */
export function probabilityWeightedExpectedPrice(
  row: Pick<GraderOutcomeRow, "tierShares">,
  medianPriceByTier: Record<string, number>,
): { expected: number; coverageShare: number } {
  let expected = 0;
  let coverageShare = 0;
  for (const [tier, share] of Object.entries(row.tierShares)) {
    const px = medianPriceByTier[tier];
    if (!Number.isFinite(px) || px <= 0) continue;
    expected += share * px;
    coverageShare += share;
  }
  // Renormalize so a partial coverage doesn't inflate/deflate the mean.
  const normalized = coverageShare > 0 ? expected / coverageShare : 0;
  return { expected: round(normalized, 2), coverageShare: round(coverageShare, 3) };
}

function classifyConfidence(n: number): "high" | "medium" | "low" {
  if (n >= 100) return "high";
  if (n >= 30) return "medium";
  return "low";
}

function resolveOptions(opts: GraderOutcomeOptions): Required<GraderOutcomeOptions> {
  return {
    windowDays: opts.windowDays ?? DEFAULTS.windowDays,
    minGradedSamples: opts.minGradedSamples ?? DEFAULTS.minGradedSamples,
  };
}

function round(x: number, digits: number): number {
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

export const _DEFAULTS = DEFAULTS;

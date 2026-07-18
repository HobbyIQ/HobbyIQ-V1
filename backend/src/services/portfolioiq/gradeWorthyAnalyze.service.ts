// CF-GRADE-WORTHY (Drew, 2026-07-17). Orchestration: given a holding,
// pull the SKU's grader premium curve from local comp store, pull
// applicable grading costs from the catalog, and analyze.
//
// v1 scope:
//  - Analyzes a SINGLE holding (per-card endpoint)
//  - Portfolio-scan is built by iterating this in the routes handler
//
// The pure math is in gradeWorthyCompute.service.ts.

import { lookupLocalComps } from "./localCompStore.service.js";
import { readPlayerTrend } from "./playerTrendStore.service.js";
import { analyzeGradeWorthy } from "./gradeWorthyCompute.service.js";
import { GRADING_TIERS, type GraderId } from "./gradingTiers.js";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import type {
  GradeWorthyAnalysis,
  GraderPremiumInput,
} from "../../types/gradeWorthy.types.js";
// CF-GRADE-WORTHY-FAMILY-BLENDING (Drew, 2026-07-17): observed family
// multipliers as fallback when a specific SKU has no graded comps
// but its `card_set_type` family has hundreds of them across
// hundreds of other cards.
import { readFamilyMultipliers } from "./observedMultipliersStore.service.js";
import { slugFamily } from "./observedMultipliersCompute.service.js";

/** Derive a { "psa-regular": 79.99, "bgs-regular": 65, ... } Record from
 *  the catalog. Picks the cheapest ACTIVE tier per grader — v1 doesn't
 *  match declared-value cap; a follow-up can pick per-tier by expected
 *  graded price. */
export function buildGradingCostCatalog(): Record<string, number> {
  const out: Record<string, number> = {};
  const cheapestByGrader = new Map<GraderId, number>();
  for (const tier of GRADING_TIERS) {
    if (!tier.active) continue;
    if (typeof tier.pricePerCard !== "number") continue;
    const existing = cheapestByGrader.get(tier.grader);
    if (existing === undefined || tier.pricePerCard < existing) {
      cheapestByGrader.set(tier.grader, tier.pricePerCard);
    }
  }
  for (const [grader, price] of cheapestByGrader.entries()) {
    const graderLower = grader.toLowerCase();
    out[`${graderLower}-regular`] = price; // matches compute's preferred-key order
    out[graderLower] = price;
  }
  // Default when a grader isn't in the catalog (CGC, TAG, etc).
  if (!("default" in out)) out.default = 60;
  return out;
}

/** CF-GRADE-WORTHY-FAMILY-BLENDING (Drew, 2026-07-17): normalize an
 *  incoming set-name or product-name into a family key that maps to
 *  the observed_grader_multipliers container. Handles common iOS-
 *  supplied shapes:
 *    "2026 Bowman Baseball"     → "bowman_baseball"
 *    "2026 Bowman Chrome Baseball" → "bowman_chrome_baseball"
 *    "Bowman Chrome"             → "bowman_chrome"
 *  Strips a leading 4-digit year + optional whitespace when present. */
export function deriveFamilyKey(setOrProduct: string): string {
  const trimmed = String(setOrProduct ?? "").trim();
  if (!trimmed) return "";
  // Strip leading YYYY (or YYYY-YY) if present.
  const noYear = trimmed.replace(/^\s*\d{4}(?:-\d{2,4})?\s+/, "");
  return slugFamily(noYear);
}

/** CF-GRADE-WORTHY-FAMILY-BLENDING: given family-level multipliers
 *  (observed as median(graded)/median(raw) per tier for a card_set_type)
 *  and a raw price, synthesize graderPremium entries for tiers we can't
 *  get from the specific SKU's local comps. Only fills tiers NOT already
 *  present in localGraderPremiums (SKU-specific data always wins).
 *
 *  Confidence gate: only "high" or "medium" family confidence is used —
 *  "low" would be adding noise, not signal. */
export function blendFamilyMultipliersIntoGraderPremiums(
  localGraderPremiums: Record<string, GraderPremiumInput>,
  rawPrice: number,
  familyMultipliers: Array<{
    graderTier: string;
    multiplier: number;
    confidence: "high" | "medium" | "low";
    nGraded: number;
  }>,
): {
  premiums: Record<string, GraderPremiumInput>;
  familyBlendedTiers: string[];
} {
  const merged = { ...localGraderPremiums };
  const familyBlendedTiers: string[] = [];

  if (!(rawPrice > 0)) {
    return { premiums: merged, familyBlendedTiers };
  }

  for (const fm of familyMultipliers) {
    if (fm.confidence === "low") continue;
    const existing = merged[fm.graderTier];
    // SKU-specific data with n >= 3 wins over family blend.
    if (existing && existing.n >= 3) continue;
    const meanPrice = rawPrice * fm.multiplier;
    // We attribute the "n" to the family sample so downstream
    // gate can distinguish blended (fm.nGraded high-family-n)
    // from thin-SKU (nGraded local n).
    merged[fm.graderTier] = {
      n: fm.nGraded,
      meanPrice,
      multiplierVsBaseline: fm.multiplier,
    };
    familyBlendedTiers.push(fm.graderTier);
  }
  return { premiums: merged, familyBlendedTiers };
}

/** Analyze a single holding. Bails cleanly (insufficient_data) when
 *  the SKU has no local corpus coverage or when the holding is already
 *  graded. */
export async function analyzeHoldingGradeWorthy(
  holding: PortfolioHolding,
): Promise<{
  analysis: GradeWorthyAnalysis;
  failureRate: import("./gradeFailureRatePricing.js").GradeFailureRateResult | null;
  diagnostics: {
    localCorpusRows: number;
    playerMomentum: number | null;
    playerMomentumDirection: "up" | "flat" | "down" | null;
    familyKey: string | null;
    familyBlendedTiers: string[];
  };
}> {
  // Only raw holdings are candidates. Already-graded cards don't get
  // regrade recommendations from this service.
  const gradeCompany = holding.gradingCompany ?? holding.gradeCompany;
  if (gradeCompany && String(gradeCompany).trim().length > 0) {
    return {
      analysis: {
        rawPrice: 0,
        bestTier: null,
        allTiers: [],
        overallRecommendation: "not_worth",
        reason: "Already graded — regrade analysis out of scope",
      },
      failureRate: null,
      diagnostics: {
        localCorpusRows: 0,
        playerMomentum: null,
        playerMomentumDirection: null,
        familyKey: null,
        familyBlendedTiers: [],
      },
    };
  }

  const player = (holding.playerName ?? "").trim();
  const year = typeof holding.cardYear === "number" ? holding.cardYear : undefined;
  const number = (holding.cardNumber ?? "").trim();

  if (!player) {
    return {
      analysis: {
        rawPrice: 0,
        bestTier: null,
        allTiers: [],
        overallRecommendation: "insufficient_data",
        reason: "Holding is missing player identity — cannot look up corpus",
      },
      failureRate: null,
      diagnostics: {
        localCorpusRows: 0,
        playerMomentum: null,
        playerMomentumDirection: null,
        familyKey: null,
        familyBlendedTiers: [],
      },
    };
  }

  // Pull local corpus for this SKU — allGrades=true so we get raw + all
  // graded tiers to build the grader premium curve.
  const localResult = await lookupLocalComps(
    {
      player,
      year,
      number: number || undefined,
      allGrades: true,
    },
    { skipPremiums: false },
  );

  // Cheap-side derivation: rawPrice = graderPremiums["Raw"].meanPrice
  // if present, else fall back to holding.fairMarketValue.
  const rawEntry: GraderPremiumInput | undefined = localResult.graderPremiums["Raw"];
  const rawPrice =
    rawEntry && rawEntry.n >= 3 ? rawEntry.meanPrice :
    typeof holding.fairMarketValue === "number" ? holding.fairMarketValue :
    0;

  // Player-level momentum context.
  let playerMomentum: number | null = null;
  let playerMomentumDirection: "up" | "flat" | "down" | null = null;
  try {
    const trend = await readPlayerTrend(player);
    if (trend) {
      playerMomentum = trend.momentum;
      playerMomentumDirection = trend.direction;
    }
  } catch {
    // best-effort — don't fail the analysis just because trend store is offline
  }

  // CF-GRADE-WORTHY-FAMILY-BLENDING (Drew, 2026-07-17): if the SKU-
  // specific graderPremiums are sparse (missing PSA 10 entirely, or n<3),
  // fall back to observed family multipliers. Family key = normalized
  // setName (year stripped), else product. Best-effort — an empty
  // multipliers row just leaves the analysis unchanged.
  const rawSetOrProduct =
    (typeof holding.setName === "string" && holding.setName.trim().length > 0
      ? holding.setName
      : typeof holding.product === "string" && holding.product.trim().length > 0
        ? holding.product
        : "");
  const familyKey = rawSetOrProduct ? deriveFamilyKey(rawSetOrProduct) : "";
  let familyBlendedTiers: string[] = [];
  let mergedPremiums = localResult.graderPremiums;
  if (familyKey && rawPrice > 0) {
    try {
      const familyRows = await readFamilyMultipliers(familyKey);
      if (familyRows.length > 0) {
        const blend = blendFamilyMultipliersIntoGraderPremiums(
          localResult.graderPremiums,
          rawPrice,
          familyRows.map((r) => ({
            graderTier: r.graderTier,
            multiplier: r.multiplier,
            confidence: r.confidence,
            nGraded: r.nGraded,
          })),
        );
        mergedPremiums = blend.premiums;
        familyBlendedTiers = blend.familyBlendedTiers;
      }
    } catch {
      // best-effort — sparse local pool is not fatal
    }
  }

  const analysis = analyzeGradeWorthy({
    rawPrice,
    graderPremiums: mergedPremiums,
    gradingCosts: buildGradingCostCatalog(),
    playerMomentumDirection: playerMomentumDirection ?? undefined,
  });

  // CF-GRADE-FAILURE-RATE (Drew, 2026-07-17): compute the failure-rate
  // block from the family's observed grader-outcome distribution.
  // Best-effort — silently returns null when the outcome-distribution
  // container is missing / empty for this family (which is the case
  // for many long-tail families right now). Sits alongside `analysis`
  // in the response so iOS renders it as its own block with the
  // verbatim caveat.
  let failureRate: import("./gradeFailureRatePricing.js").GradeFailureRateResult | null = null;
  if (familyKey && rawPrice > 0 && analysis.bestTier) {
    try {
      const { readFamilyOutcomes } = await import("./graderOutcomeStore.service.js");
      const { computeGradeFailureRate } = await import("./gradeFailureRatePricing.js");
      const outcomes = await readFamilyOutcomes(familyKey);
      // Choose the grader row matching the analysis's best-tier grader.
      const bestTierParts = analysis.bestTier.graderTier.split(/\s+/);
      const graderName = bestTierParts[0] ?? "PSA";
      const outcomeRow = outcomes.find((o) => o.grader === graderName)
        ?? outcomes[0]
        ?? null;
      if (outcomeRow) {
        // Pull per-tier prices from the merged grader premiums (observed +
        // family-blended). Skip Raw — it's the anchor, not an outcome tier.
        const tierPrices: Record<string, number> = {};
        for (const [tier, premium] of Object.entries(mergedPremiums)) {
          if (tier === "Raw") continue;
          if (premium && typeof premium.meanPrice === "number" && premium.meanPrice > 0) {
            tierPrices[tier] = premium.meanPrice;
          }
        }
        const gradingCost = buildGradingCostCatalog()[
          `${graderName.toLowerCase()}-regular`
        ] ?? buildGradingCostCatalog()[graderName.toLowerCase()]
          ?? buildGradingCostCatalog().default
          ?? 60;
        failureRate = computeGradeFailureRate({
          rawPrice,
          gradingCost,
          tierShares: outcomeRow.tierShares ?? {},
          tierPrices,
          totalGradedSamples: outcomeRow.totalGradedSamples ?? 0,
        });
      }
    } catch {
      // silent — no failure-rate block is not fatal
    }
  }

  return {
    analysis,
    failureRate,
    diagnostics: {
      localCorpusRows: localResult.totalSales,
      playerMomentum,
      playerMomentumDirection,
      familyKey: familyKey || null,
      familyBlendedTiers,
    },
  };
}

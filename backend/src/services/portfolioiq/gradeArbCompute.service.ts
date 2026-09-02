// CF-GRADE-ARB (Drew, 2026-09-02). Grade-arbitrage surface: for a RAW
// holding, what the card is worth IF it comes back PSA 9 / PSA 10 (and
// BGS where the pool actually sampled it), from the card's OWN empirical
// grade curve, minus a disclosed grading-cost assumption.
//
// ── Why this is not gradeWorthyAnalyze.service.ts ──────────────────────
//
// A "should I grade this?" tool already exists (CF-GRADE-WORTHY,
// 2026-07-17). It reads ch_daily_sales directly through
// localCompStore/localCompPremiums and anchors each tier on
// `mean(prices)` (localCompPremiums.service.ts:47). Two doctrines have
// landed since:
//
//   1. FMV is the PROJECTED NEXT SALE from the pool's trend — never a
//      median, and emphatically never a mean.
//   2. CF-ONE-VALUATION-PATH (D16, 2026-08-30): one computation behind
//      every price. The D14 probe found four rival engines disagreeing
//      by >25% on 44.2% of (slug, Raw) — $11,995 against $88 on the
//      same three sales — because each read its own pool its own way.
//
// So this module does NOT add a fifth engine and does not re-derive a
// price. It consumes the grade curve the ONE path already produced
// (oneValuationPath.valueIdentity -> Valuation.gradeCurve) and does
// arithmetic on top of it. Every dollar figure here traces to a tier the
// unified engine priced. When the engine says a tier is unavailable,
// this module says nothing about that tier.
//
// The older grade-worthy path is left untouched and still serves its own
// endpoint; retiring it is a separate decision with its own migration.
//
// ── The gem-rate caveat, which is the whole product risk ───────────────
//
// We do NOT know the card's condition. Nothing in the pool observes the
// surface, corners or centering of the specific copy in someone's
// closet. So the output is strictly conditional — "IF it grades a 10" —
// and never a promise, never an expected value weighted by a gem rate we
// have not measured for this card. A single un-caveated "+$400" here is
// a user sending a $25 check on our say-so.

import type { ObservedGradeEntry } from "../compiq/observedGradeCurve.service.js";

/** Default grading-cost assumption in USD, per card, when the
 *  environment does not override it. Deliberately a single disclosed
 *  scalar rather than a per-grader catalog: this surface says "IF it
 *  grades", and a precise fee for a service the user has not chosen
 *  would imply a precision the rest of the output does not have. */
export const DEFAULT_GRADING_COST_USD = 25;

/** The disclosure that MUST accompany any rendering of these numbers.
 *  Exported so the API, the web surface and the tests all quote the
 *  same sentence rather than three drifting paraphrases. */
export const GRADE_ARB_DISCLOSURE =
  "We do not know this card's condition. These are conditional values — what the card " +
  "would be worth IF it graded at each tier — not a prediction that it will. " +
  "Grading cost is an assumption, not a quote.";

/** Tiers this surface will speak about, in display order. PSA 9 and 10
 *  are the product ask; the BGS tiers appear only when the card's own
 *  pool actually sampled them ("BGS where sampled"). */
export const GRADE_ARB_TIERS: readonly string[] = [
  "PSA 10",
  "PSA 9",
  "BGS 9.5",
  "BGS 9",
];

export interface GradeArbTier {
  /** Canonical tier label, matching the curve's own vocabulary. */
  tier: string;
  grader: string;
  /** The tier's value from the curve. Never re-derived here. */
  gradedValue: number;
  /** gradedValue - rawValue - gradingCost. May be negative; a negative
   *  number is a real answer ("grading destroys value here"), not a
   *  reason to hide the tier. */
  netGain: number;
  /** netGain / (rawValue + gradingCost) — return on the total outlay,
   *  null when that denominator is not positive. */
  netGainPct: number | null;
  /** Pool size behind this tier's number. */
  sampleCount: number;
  /** The engine's rung for this tier, in the closed vocabulary. */
  rungLabel: string | null;
  /** How the engine got the tier: "observed" is a real pool at the
   *  tier; "estimated" is this card's own sales carried across grades by
   *  an empirical ratio. Both are empirical; the caller renders the
   *  difference. */
  valueSource: "observed" | "estimated";
  confidence: number;
  /** Prose naming the source of THIS tier's number: n, tier, family. */
  basis: string;
}

export type GradeArbRefusal =
  /** The holding is already graded — nothing to arbitrage. */
  | "not-raw"
  /** The curve has no Raw number, so there is no baseline to subtract. */
  | "no-raw-basis"
  /** Raw is priced, but no graded tier has any empirical basis. */
  | "no-graded-basis";

export interface GradeArbResult {
  /** True only when at least one tier survived. */
  available: boolean;
  refusal: GradeArbRefusal | null;
  /** Human-readable reason, present exactly when refusal is. */
  refusalReason: string | null;
  rawValue: number | null;
  gradingCostUsd: number;
  /** Present whenever `available`. Highest netGain first. */
  tiers: GradeArbTier[];
  /** The best tier by netGain, or null. Convenience for a chip. */
  bestTier: GradeArbTier | null;
  /** The verbatim caveat. Always present, including on refusals, so a
   *  caller can never render numbers without having been handed it. */
  disclosure: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Read the grading-cost assumption. Env override, else the default.
 *  A non-finite or negative override is ignored rather than trusted —
 *  a negative cost would silently manufacture profit. */
export function resolveGradingCostUsd(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.GRADE_ARB_COST_USD;
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_GRADING_COST_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_GRADING_COST_USD;
  return n;
}

/** True when a curve entry carries an empirical number this surface may
 *  speak from.
 *
 *  "unavailable" is the engine saying it has nothing — refuse.
 *  A null or non-positive value is the same thing regardless of label.
 *
 *  "estimated" IS allowed, and that is a deliberate reading of the
 *  empirical-only doctrine rather than a loophole: on the one-valuation
 *  path an estimated tier is THIS card's own observed sales carried
 *  across grades by a GRADE_CALIBRATION ratio measured from our own
 *  pool (family, byTier). It is not an invented or hand-tuned
 *  multiplier. The tier reports its source so the caller can mark it. */
export function tierHasEmpiricalBasis(
  entry: Pick<ObservedGradeEntry, "value" | "valueSource"> | undefined | null,
): boolean {
  if (!entry) return false;
  if (entry.valueSource === "unavailable") return false;
  return typeof entry.value === "number" && Number.isFinite(entry.value) && entry.value > 0;
}

/** Compose the basis sentence for one tier: n, tier, family/rung.
 *  Quotes the curve's own numbers — it never characterizes them. */
export function basisSentenceFor(
  entry: ObservedGradeEntry,
  opts: { family?: string | null } = {},
): string {
  const tier = String(entry.grade);
  const family = opts.family?.trim();
  const familyPart = family ? ` in ${family}` : "";
  const rung = entry.rungLabel ? ` via ${entry.rungLabel}` : "";
  if (entry.valueSource === "observed") {
    const n = entry.sampleCount;
    const sales = n === 1 ? "1 sale" : `${n} sales`;
    return `${tier}${familyPart}: projected from ${sales} of this card at ${tier}${rung}.`;
  }
  // Estimated: this card's own sales carried across grades by an
  // empirical ratio. Name the ratio when the curve carried one.
  const mult = entry.estimatedMultiplier;
  const from = entry.estimatedFrom ? ` from its ${entry.estimatedFrom} sales` : "";
  const multPart = typeof mult === "number" && Number.isFinite(mult)
    ? ` (${round2(mult)}x empirical ratio)`
    : "";
  return `${tier}${familyPart}: estimated${from}${multPart}${rung} — no ${tier} sale of this card in the window.`;
}

/**
 * The arithmetic. Pure: a curve in, an arb surface out. No I/O, no
 * engine call, no clock — so a fixture curve pins every number by hand.
 *
 * netGain = gradedValue - rawValue - gradingCost, per tier.
 */
export function computeGradeArb(input: {
  /** Every canonical tier from the ONE path's Valuation.gradeCurve. */
  gradeCurve: readonly ObservedGradeEntry[];
  /** True when the holding carries no grading company. */
  isRaw: boolean;
  gradingCostUsd?: number;
  /** Product family, for the basis sentence. */
  family?: string | null;
  /** Restrict to these tiers; defaults to GRADE_ARB_TIERS. */
  tiers?: readonly string[];
}): GradeArbResult {
  const gradingCostUsd = input.gradingCostUsd ?? resolveGradingCostUsd();
  const base: Omit<GradeArbResult, "refusal" | "refusalReason"> = {
    available: false,
    rawValue: null,
    gradingCostUsd,
    tiers: [],
    bestTier: null,
    disclosure: GRADE_ARB_DISCLOSURE,
  };

  if (!input.isRaw) {
    return {
      ...base,
      refusal: "not-raw",
      refusalReason: "Holding is already graded — grade arbitrage applies to raw cards only.",
    };
  }

  const curve = input.gradeCurve ?? [];
  // Prefer a Raw entry that actually carries a number: the canonical
  // curve holds exactly one, but a pool-appended tier could add a second
  // Raw-grader row, and picking a blank one first would refuse a card we
  // can in fact price.
  const rawCandidates = curve.filter(
    (e) => String(e.grade).trim().toLowerCase() === "raw" || e.grader === "Raw",
  );
  const rawEntry = rawCandidates.find(tierHasEmpiricalBasis) ?? rawCandidates[0];
  if (!tierHasEmpiricalBasis(rawEntry)) {
    return {
      ...base,
      refusal: "no-raw-basis",
      refusalReason:
        "No empirical raw value for this card — nothing to compare a graded outcome against.",
    };
  }
  const rawValue = round2(rawEntry!.value as number);

  const wanted = input.tiers ?? GRADE_ARB_TIERS;
  const tiers: GradeArbTier[] = [];
  for (const label of wanted) {
    const matches = curve.filter((e) => String(e.grade).trim() === label);
    const entry = matches.find(tierHasEmpiricalBasis) ?? matches[0];
    if (!tierHasEmpiricalBasis(entry)) continue; // refuse per-tier, silently
    const gradedValue = round2(entry!.value as number);
    const netGain = round2(gradedValue - rawValue - gradingCostUsd);
    const denom = rawValue + gradingCostUsd;
    tiers.push({
      tier: label,
      grader: entry!.grader,
      gradedValue,
      netGain,
      netGainPct: denom > 0 ? Math.round((netGain / denom) * 10000) / 100 : null,
      sampleCount: entry!.sampleCount ?? 0,
      rungLabel: entry!.rungLabel ?? null,
      valueSource: entry!.valueSource === "observed" ? "observed" : "estimated",
      confidence: entry!.confidenceScore ?? 0,
      basis: basisSentenceFor(entry!, { family: input.family }),
    });
  }

  if (tiers.length === 0) {
    return {
      ...base,
      rawValue,
      refusal: "no-graded-basis",
      refusalReason:
        "This card has no graded sales and no empirical ratio to project one — no graded outcome to show.",
    };
  }

  tiers.sort((a, b) => b.netGain - a.netGain);
  return {
    ...base,
    available: true,
    refusal: null,
    refusalReason: null,
    rawValue,
    tiers,
    bestTier: tiers[0],
  };
}

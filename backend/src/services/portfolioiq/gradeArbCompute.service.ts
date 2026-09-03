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
//
// ── The empirical gate (2026-09-02, hardening) ─────────────────────────
//
// Every dollar figure on this surface comes from OBSERVED sales of this
// card at that tier, with a pool of at least MIN_GRADED_COMPS. This
// module originally admitted "estimated" tiers on the argument that a
// GRADE_CALIBRATION ratio is itself measured from our pool. That
// argument does not survive contact with the live curve: its estimated
// branches include a hand-tuned per-tier constant ("raw-multiplier",
// observedGradeCurve.service.ts:197) and a third-party model number
// ("reference-price"). Neither is a sale of this card. On a real
// $7.89 raw card the multiplier path produces "PSA 8 = $302.47", and
// this surface would have rendered "+$269 IF you grade it" beside a
// $25 cheque. A family ratio is evidence about the family; the user is
// grading one card.

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
  /** Real graded sales of this card at this tier behind the number.
   *  Always >= MIN_GRADED_COMPS — a thinner tier is refused, not shown. */
  sampleCount: number;
  /** The engine's rung for this tier, in the closed vocabulary. */
  rungLabel: string | null;
  /** Always "observed" on this surface: an estimated tier never reaches
   *  a caller. Kept on the wire so a client that rendered an "est."
   *  badge keeps compiling, and so the value is self-describing. */
  valueSource: "observed";
  confidence: number;
  /** Prose naming the source of THIS tier's number: n, tier, family. */
  basis: string;
}

export type GradeArbRefusal =
  /** The holding is already graded — nothing to arbitrage. */
  | "not-raw"
  /** The curve has no Raw number, so there is no baseline to subtract. */
  | "no-raw-basis"
  /** Raw is priced, but no graded tier is observed with a deep enough
   *  pool. The reason names the counts that fell short. */
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

/** The floor of REAL graded sales a tier must carry before this surface
 *  will put a dollar figure on it. Three is the smallest pool from which
 *  the engine reports a non-trivial confidence (observedGradeCurve:
 *  n=1 -> 0.20, n=3 -> 0.50), and below it a single outlier IS the
 *  "market": two sales of $8 and $302 average to a number no one has
 *  ever paid. */
export const MIN_GRADED_COMPS = 3;

/** Why a tier was refused, in the vocabulary the caller renders. */
export type TierRefusalReason = "unavailable" | "estimated" | "thin-pool" | "no-value";

export interface TierGateResult {
  ok: boolean;
  reason: TierRefusalReason | null;
  /** The tier's TRUE count of real graded sales. Always named on a
   *  refusal so the message can quote it. */
  sampleCount: number;
}

/** The empirical gate. A tier may carry a dollar figure on this surface
 *  only when it is OBSERVED — real sales of this card at this tier —
 *  and the pool is at least MIN_GRADED_COMPS deep.
 *
 *  Estimated tiers are REFUSED, and the earlier reading of this module
 *  (that "estimated" is empirical enough because a GRADE_CALIBRATION
 *  ratio is measured from our pool) was wrong on the facts. The live
 *  curve's estimated branches include `estimatedFrom: "raw-multiplier"`
 *  — a hand-tuned per-tier constant (observedGradeCurve.service.ts:197)
 *  — and `"reference-price"`, a third-party model's number. Neither is
 *  a sale of this card at this tier. Multiplying a $7.89 raw anchor by
 *  a family constant yields rows like "PSA 8 = $302.47" (38.34x), which
 *  this surface would have rendered as "+$269 if you grade it" next to
 *  a $25 cheque. A ratio measured across a family is evidence about the
 *  family, not about this card.
 *
 *  So the gate is: observed, priced, and n >= MIN_GRADED_COMPS. The
 *  count is the curve's own per-tier `sampleCount` — the number of real
 *  sales behind that tier's median. (The canonical `gradeLadder` cannot
 *  answer this: its tiers carry only {grader, medianRatio, fmv}, every
 *  non-Raw row is rawAnchor x calibration multiplier, and its
 *  `sampleSize` is a literal placeholder. A gate reading the ladder
 *  would be a gate reading multiplication, which is why this surface
 *  reads the curve.) */
export function gateTier(
  entry: Pick<ObservedGradeEntry, "value" | "valueSource" | "sampleCount"> | undefined | null,
): TierGateResult {
  const n = typeof entry?.sampleCount === "number" && Number.isFinite(entry.sampleCount)
    ? entry.sampleCount
    : 0;
  if (!entry) return { ok: false, reason: "unavailable", sampleCount: 0 };
  if (entry.valueSource === "unavailable") return { ok: false, reason: "unavailable", sampleCount: n };
  const priced = typeof entry.value === "number" && Number.isFinite(entry.value) && entry.value > 0;
  if (!priced) return { ok: false, reason: "no-value", sampleCount: n };
  // Not a sale of this card at this tier — a projection. Refuse before
  // the count is even consulted, so the reason names the real defect.
  if (entry.valueSource !== "observed") return { ok: false, reason: "estimated", sampleCount: n };
  if (n < MIN_GRADED_COMPS) return { ok: false, reason: "thin-pool", sampleCount: n };
  return { ok: true, reason: null, sampleCount: n };
}

/** True when a curve entry may carry a dollar figure on this surface.
 *  Thin wrapper over gateTier, kept because call sites read better as a
 *  predicate. */
export function tierHasEmpiricalBasis(
  entry: Pick<ObservedGradeEntry, "value" | "valueSource" | "sampleCount"> | undefined | null,
): boolean {
  return gateTier(entry).ok;
}

/** The raw baseline is subtracted from every tier, so it is held to the
 *  same standard: a raw anchor that is itself an estimate would make
 *  every netGain on the surface an estimate wearing an observed label. */
export function rawTierHasEmpiricalBasis(
  entry: Pick<ObservedGradeEntry, "value" | "valueSource" | "sampleCount"> | undefined | null,
): boolean {
  return gateTier(entry).ok;
}

/** Name the shortfall when no graded tier survived the gate. Quotes the
 *  real counts rather than saying "no data": "PSA 10 has 2 graded sales
 *  (3 required)" is a fact a user can act on — wait for the market to
 *  deepen — where a shrug is not. */
export function describeGradedRefusal(
  refused: ReadonlyArray<{ tier: string; gate: TierGateResult }>,
): string {
  const thin = refused.filter((r) => r.gate.reason === "thin-pool");
  const estimated = refused.filter((r) => r.gate.reason === "estimated");
  const parts: string[] = [];
  if (thin.length > 0) {
    parts.push(
      thin
        .map((r) => `${r.tier} has ${r.gate.sampleCount} graded ${r.gate.sampleCount === 1 ? "sale" : "sales"}`)
        .join(", ") + ` (${MIN_GRADED_COMPS} required)`,
    );
  }
  if (estimated.length > 0) {
    parts.push(
      `${estimated.map((r) => r.tier).join(", ")} ${estimated.length === 1 ? "is" : "are"} estimated from a family ratio, not sales of this card`,
    );
  }
  if (parts.length === 0) {
    return "This card has no graded sales of its own — no graded outcome to show.";
  }
  return `Not enough real graded sales of this card: ${parts.join("; ")}. No graded outcome to show.`;
}

/** Compose the basis sentence for one tier: n, tier, family/rung.
 *  Quotes the curve's own numbers — it never characterizes them.
 *
 *  Only observed tiers reach this function (see gateTier), so there is
 *  one branch and it names real sales. */
export function basisSentenceFor(
  entry: ObservedGradeEntry,
  opts: { family?: string | null } = {},
): string {
  const tier = String(entry.grade);
  const family = opts.family?.trim();
  const familyPart = family ? ` in ${family}` : "";
  const rung = entry.rungLabel ? ` via ${entry.rungLabel}` : "";
  const n = entry.sampleCount;
  const sales = n === 1 ? "1 sale" : `${n} sales`;
  return `${tier}${familyPart}: projected from ${sales} of this card at ${tier}${rung}.`;
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
  const rawEntry = rawCandidates.find(rawTierHasEmpiricalBasis) ?? rawCandidates[0];
  const rawGate = gateTier(rawEntry);
  if (!rawGate.ok) {
    return {
      ...base,
      refusal: "no-raw-basis",
      refusalReason: rawGate.reason === "thin-pool"
        ? `Raw value for this card rests on ${rawGate.sampleCount} ${rawGate.sampleCount === 1 ? "sale" : "sales"} — fewer than the ${MIN_GRADED_COMPS} required — so there is no baseline to compare a graded outcome against.`
        : rawGate.reason === "estimated"
          ? "The raw value for this card is estimated, not observed — no measured baseline to compare a graded outcome against."
          : "No empirical raw value for this card — nothing to compare a graded outcome against.",
    };
  }
  const rawValue = round2(rawEntry!.value as number);

  const wanted = input.tiers ?? GRADE_ARB_TIERS;
  const tiers: GradeArbTier[] = [];
  // Why each refused tier was refused, so the whole-surface refusal can
  // quote real counts instead of a shrug.
  const refusedTiers: Array<{ tier: string; gate: TierGateResult }> = [];
  for (const label of wanted) {
    const matches = curve.filter((e) => String(e.grade).trim() === label);
    const entry = matches.find(tierHasEmpiricalBasis) ?? matches[0];
    const gate = gateTier(entry);
    if (!gate.ok) {
      // A tier the curve never mentioned is absent, not refused.
      if (matches.length > 0) refusedTiers.push({ tier: label, gate });
      continue;
    }
    const gradedValue = round2(entry!.value as number);
    const netGain = round2(gradedValue - rawValue - gradingCostUsd);
    const denom = rawValue + gradingCostUsd;
    tiers.push({
      tier: label,
      grader: entry!.grader,
      gradedValue,
      netGain,
      netGainPct: denom > 0 ? Math.round((netGain / denom) * 10000) / 100 : null,
      sampleCount: gate.sampleCount,
      rungLabel: entry!.rungLabel ?? null,
      valueSource: "observed",
      confidence: entry!.confidenceScore ?? 0,
      basis: basisSentenceFor(entry!, { family: input.family }),
    });
  }

  if (tiers.length === 0) {
    return {
      ...base,
      rawValue,
      refusal: "no-graded-basis",
      refusalReason: describeGradedRefusal(refusedTiers),
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

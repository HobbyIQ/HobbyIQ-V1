// CF-BUYERIQ-DEAL-GATE (Drew, 2026-09-02). The arithmetic and the
// gating for the BuyerIQ deal scanner, extracted from any I/O so it is
// testable as pure functions and so the thresholds are readable in one
// place.
//
// The question the gate answers: "is this live ask far enough under our
// projected next sale, given how much we trust that projection, to be
// worth telling a buyer about?"
//
// THREE INDEPENDENT REASONS a listing does not flag:
//
//   1. NO BASIS. The projection did not come from anywhere — method
//      `no-basis`, or a null/non-positive fmv. There is nothing to be a
//      discount FROM. This is a refusal, not a low score.
//
//   2. SPECULATIVE CONFIDENCE. The projection is at or under the
//      speculative tier (playerIndex.SPECULATIVE_CONFIDENCE = 0.20 — an
//      anchor older than 180 days carried on a player index). Drew's
//      ruling: speculation never flags a deal, at ANY discount. A
//      0.2-confidence projection 25% under does NOT flag. There is no
//      discount deep enough to rescue a number we do not believe,
//      because a "90% discount" off a speculative projection is
//      evidence the projection is wrong, not evidence of a deal.
//
//   3. DISCOUNT UNDER THE CONFIDENCE-WEIGHTED THRESHOLD. Above the
//      speculative floor the required discount slides: a thin-pool
//      projection must be beaten by more to flag than a well-evidenced
//      one. See requiredDiscountPct below.
//
// We do NOT change any valuation. The gate reads fmv, confidence and
// rungLabel as computed by canonicalFmv and decides only whether to
// SHOW the listing. No number here feeds back into pricing.

import { SPECULATIVE_CONFIDENCE } from "../compiq/playerIndex.service.js";
import { isExactPoolRung, type FmvRungLabel } from "../compiq/fmvRung.js";
import type { CanonicalFmvMethod } from "../compiq/canonicalFmv.service.js";

/** Default discount a listing must clear at FULL confidence, as a
 *  fraction of the projection. Drew's default: 20% under. */
export const DEFAULT_BASE_DISCOUNT_PCT = 0.20;

/** The confidence at which the base threshold applies as-is. At lower
 *  confidence the requirement is scaled up toward MAX_REQUIRED_DISCOUNT_PCT. */
export const FULL_CONFIDENCE = 0.9;

/** Hard ceiling on the required discount. A projection we barely trust
 *  still cannot demand an implausible discount — past this we would be
 *  flagging only mispriced/counterfeit listings, which is not the
 *  product. Above the ceiling the gate simply never flags. */
export const MAX_REQUIRED_DISCOUNT_PCT = 0.60;

/** Confidence at or below which NOTHING flags, whatever the discount.
 *  Reuses the engine's own speculative ceiling so the two move together. */
export const MIN_FLAGGABLE_CONFIDENCE = SPECULATIVE_CONFIDENCE;

/** Methods that are, by definition, not a basis to discount from. */
const NO_BASIS_METHODS: ReadonlySet<string> = new Set<CanonicalFmvMethod>([
  "no-basis",
]);

export type DealRefusal =
  | "no-basis"
  | "speculative-confidence"
  | "below-threshold"
  | "no-listing-price";

export interface DealBasis {
  /** The projected next sale the discount is measured against. */
  projection: number;
  /** Which rung produced that projection (fmvRung vocabulary). */
  rung: FmvRungLabel | null;
  /** Whether that rung read the exact (identity, grade) pool. */
  exactPool: boolean;
  /** The projection's self-reported confidence, 0-1. */
  confidence: number;
  /** Discount this listing actually carries, as a fraction (0.25 = 25% under). */
  discountPct: number;
  /** Discount this listing had to clear to flag, given the confidence. */
  requiredDiscountPct: number;
}

export interface DealVerdict {
  flagged: boolean;
  /** Present only when flagged === false. */
  refusal: DealRefusal | null;
  /** Present whenever a projection existed at all — a refused listing
   *  still carries its basis so the feed can explain the near-miss. */
  basis: DealBasis | null;
}

/** The discount fraction a listing carries against a projection.
 *  Positive = listed UNDER the projection. Returns 0 for degenerate
 *  inputs so a bad price can never manufacture a discount. */
export function discountPct(listingPrice: number, projection: number): number {
  if (!Number.isFinite(projection) || projection <= 0) return 0;
  if (!Number.isFinite(listingPrice) || listingPrice <= 0) return 0;
  return (projection - listingPrice) / projection;
}

/**
 * Confidence-weighted required discount.
 *
 * At `FULL_CONFIDENCE` (0.9) and above, the caller's base threshold
 * applies unchanged — a projection we trust needs only the configured
 * discount (default 20%).
 *
 * Below that, the requirement scales up in inverse proportion to
 * confidence: a thin-pool projection must be beaten by more before we
 * are willing to call it a deal, because the projection itself might be
 * the thing that is wrong.
 *
 *     required = base × (FULL_CONFIDENCE / confidence)
 *
 * capped at MAX_REQUIRED_DISCOUNT_PCT. Worked examples at base = 0.20:
 *
 *     confidence 0.90 → 0.200   (20% under flags)
 *     confidence 0.80 → 0.225   (25% under flags — Drew's pin)
 *     confidence 0.60 → 0.300
 *     confidence 0.40 → 0.450
 *     confidence 0.30 → 0.600   (at the cap)
 *     confidence 0.20 → refused outright (speculative), never reaches here
 */
export function requiredDiscountPct(
  confidence: number,
  baseDiscountPct: number = DEFAULT_BASE_DISCOUNT_PCT,
): number {
  const base = clampBase(baseDiscountPct);
  if (!Number.isFinite(confidence) || confidence <= 0) {
    return MAX_REQUIRED_DISCOUNT_PCT;
  }
  if (confidence >= FULL_CONFIDENCE) return base;
  const scaled = base * (FULL_CONFIDENCE / confidence);
  return Math.min(MAX_REQUIRED_DISCOUNT_PCT, Math.round(scaled * 10000) / 10000);
}

function clampBase(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return DEFAULT_BASE_DISCOUNT_PCT;
  return Math.max(0.02, Math.min(MAX_REQUIRED_DISCOUNT_PCT, pct));
}

/** True when the projection is not a thing we may discount from. */
export function isNoBasis(
  fmv: number | null | undefined,
  method: string | null | undefined,
): boolean {
  if (fmv === null || fmv === undefined) return true;
  if (!Number.isFinite(fmv) || fmv <= 0) return true;
  if (typeof method === "string" && NO_BASIS_METHODS.has(method)) return true;
  return false;
}

export interface EvaluateDealInput {
  listingPrice: number;
  fmv: number | null;
  confidence: number;
  method: string | null;
  rungLabel?: FmvRungLabel | null;
  /** Caller's configured base threshold; defaults to 20% under. */
  baseDiscountPct?: number;
}

/**
 * The whole gate, as one pure function. Order matters: no-basis and
 * speculative-confidence are REFUSALS checked before any arithmetic, so
 * a deep discount can never talk its way past them.
 */
export function evaluateDeal(input: EvaluateDealInput): DealVerdict {
  const { listingPrice, fmv, confidence, method } = input;

  // 1. No basis — nothing to discount from. Refuse before arithmetic.
  if (isNoBasis(fmv, method)) {
    return { flagged: false, refusal: "no-basis", basis: null };
  }
  const projection = fmv as number;

  if (!Number.isFinite(listingPrice) || listingPrice <= 0) {
    return { flagged: false, refusal: "no-listing-price", basis: null };
  }

  const conf = Number.isFinite(confidence) ? confidence : 0;
  const rung = input.rungLabel ?? null;
  const pct = discountPct(listingPrice, projection);
  const required = requiredDiscountPct(conf, input.baseDiscountPct);
  const basis: DealBasis = {
    projection,
    rung,
    exactPool: isExactPoolRung(rung),
    confidence: conf,
    discountPct: pct,
    requiredDiscountPct: required,
  };

  // 2. Speculative confidence — refuse at ANY discount. Checked after
  //    the basis is built so the feed can still explain the near-miss,
  //    but before the threshold comparison so no discount can pass it.
  if (conf <= MIN_FLAGGABLE_CONFIDENCE) {
    return { flagged: false, refusal: "speculative-confidence", basis };
  }

  // 3. Threshold.
  if (pct < required) {
    return { flagged: false, refusal: "below-threshold", basis };
  }

  return { flagged: true, refusal: null, basis };
}

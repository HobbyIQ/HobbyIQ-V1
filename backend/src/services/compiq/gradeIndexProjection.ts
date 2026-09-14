/**
 * CF-EXACT-POOL-GRADE-INDEX (RULING, Drew 2026-09-13).
 *
 *   "A graded tier must be priced from the WHOLE card's trend across grades,
 *    recency-weighted, not frozen on the tier's own last sale."
 *
 * ── The defect this closes ────────────────────────────────────────────────
 *
 * Bobby Witt Jr. 2020 Bowman Chrome CPA-BWJ base auto
 * (`hiq:baseball:2020:bowman-chrome:cpa-bwj:base:auto`). The pool holds six
 * sales spread over four tiers — 3 Raw, 2 PSA 10, 1 BGS 9.5 — and (in the
 * shape Drew asked about) one SGC 9 at $1,300 two weeks old. Not one tier has
 * eight sales, so not one tier can fit its own trend. Before this rung, the
 * SGC 9 tier read `exact-pool-last-sale` at exactly $1,300 and STAYED there:
 * R25 says the newest sale of a 1-3 sale pool IS the market, and the
 * cross-tier rescale (`getGraderPremium`, unifiedPricing ~1130-1174) fires
 * only for a tier that is COMPLETELY EMPTY. So a tier with one sale on file
 * was strictly LESS able to learn from its own card than a tier with none:
 * every Raw, PSA 10 and BGS 9.5 sale of the same card could move an empty
 * SGC 9 tier and none of them could move a populated one. The tier's single
 * sale did not inform the number, it FROZE it.
 *
 * ── The mechanism ─────────────────────────────────────────────────────────
 *
 * A card has ONE market. What differs between its tiers is a multiplier, and
 * that multiplier is something we MEASURE — GRADE_CALIBRATION byTier, per
 * sport and product family, generated from our own sold_comps pool (see
 * gradeCalibrationData.ts's generation banner: "source: sold_comps (OUR
 * pool)"). So:
 *
 *   1. Divide every sale of the identity — at ANY tier — by its own tier's
 *      empirical multiplier. Raw is 1 by definition. The result is a
 *      grade-free INDEX POINT: what that sale says the card's raw-equivalent
 *      level was on that date. A tier with no multiplier for this
 *      (sport, family) contributes NOTHING rather than contributing a
 *      guess — empirical-only doctrine, the same refusal
 *      `empiricalGradeMultiplier` already makes.
 *   2. Project the index the way the >= 8 single-tier path projects a tier:
 *      `projectFromLeadingEdge` — a recency-weighted median anchor at its own
 *      recency-weighted time, moved forward by the window's OLS fit, held
 *      inside a band of the newest point. Never a median, never a mean, of
 *      the answer itself (FMV = projected next sale — see
 *      feedback_no_medians_project_next_sale). Same function, same 14-day
 *      half-life, same sanity caps as the rung above it: ONE valuation path,
 *      not two (project_one_valuation_path_not_two).
 *   3. Multiply the index projection at NOW by the REQUESTED tier's
 *      multiplier. That is the tier's FMV.
 *
 * The requested tier's own sales are ordinary index points at their own
 * dates. A two-week-old $1,300 SGC 9 still counts — at its date, with its
 * recency weight, divided by SGC 9's own 1.29x — it simply no longer gets to
 * be the whole answer. That is the entire behavioural change.
 *
 * ── What it does NOT do ───────────────────────────────────────────────────
 *
 * It does not clamp monotonicity across tiers. If this card's PSA 10 index
 * points sit BELOW its raw index points, that inversion survives into the
 * output, because grade monotonicity is not an invariant and the right
 * response to an inversion is to observe it, never to clamp it
 * (feedback_grade_monotonicity_is_not_an_invariant). It uses no hardcoded
 * multiplier matrix: GRADE_CALIBRATION only
 * (project_empirical_only_multiplier_doctrine). And it never reaches outside
 * the identity — same hobbyiqCardId, never a sibling card, never a
 * neighbouring parallel. That is what makes it an exact-pool rung.
 */
import { projectFromLeadingEdge } from "./nextSaleProjection.service.js";

/**
 * How many sales the WHOLE card (every tier together) must hold before the
 * index rung may price a thin tier.
 *
 * N = 4, and it is the engine's own existing boundary rather than a new
 * opinion. `computeTrendAndPrediction` already treats `rows.length < 4` as
 * "too thin to read a trend at all" and hands such a pool to
 * `thinPoolReading`; the widest cascade window's density floor
 * (`WINDOWS[2].minDirect`) is 3. So four is the first pool size at which
 * this engine already believes a trend is readable. Setting N there means
 * the index rung asserts nothing about the card that the single-tier path
 * would not already assert about a tier of the same size — it only changes
 * WHICH sales are allowed to inform the answer, never how much evidence is
 * required before an answer is trended at all.
 *
 * Below N the whole card is as thin as the tier, there is no card-wide trend
 * to borrow, and R25's "the most recent sale is the market" is still the
 * honest read — so a 1-3 sale tier in a 1-3 sale card is left exactly as it
 * was.
 */
export const EXACT_POOL_INDEX_MIN_POOL = 4;

/**
 * How many of ITS OWN sales a tier needs before it keeps its own OLS and
 * this rung stands aside. 8 — the same `datedForFit.length >= 8` gate the
 * exact-pool projection already uses. A tier that can fit its own trend is
 * always preferred to an index built from other tiers: the direct evidence
 * outranks the derived, exactly as exact-pool outranks cross-grade.
 */
export const EXACT_POOL_INDEX_TIER_OWN_OLS = 8;

/**
 * Recency half-life for the index fit, in days.
 *
 * 14, and deliberately NOT an independent choice: it is `HALF_LIFE_DAYS`,
 * the half-life this module's weighted median already uses and the one
 * `projectFromLeadingEdge` is already called with on the >= 8 path. The
 * index and the single-tier OLS have to agree about how fast the market
 * forgets, or the same card would decay at two rates depending on which rung
 * answered — which is the two-valuation-paths failure in miniature. Exposed
 * as its own named constant so it can be tuned and tested, and defaulted
 * from the module's so it cannot silently drift from it.
 */
export const EXACT_POOL_INDEX_HALF_LIFE_DAYS = 14;

/** One sale, reduced to the grade-free level it implies. */
export interface GradeIndexPoint {
  /** The sale's own tier label, e.g. "Raw" / "PSA 10" / "SGC 9". */
  tier: string;
  /** The realized price. */
  price: number;
  /** ISO date of the sale. */
  soldAt: string;
  /** The tier's empirical multiplier vs raw (raw = 1). */
  multiplier: number;
  /** price / multiplier — the raw-equivalent level this sale implies. */
  indexPrice: number;
}

/** What each tier contributed to the index, for pricingSourceMeta. */
export interface GradeIndexTierContribution {
  tier: string;
  sampleCount: number;
  multiplier: number;
}

export interface GradeIndexProjection {
  /** The index level projected at now, in raw-equivalent dollars. */
  indexAtNow: number;
  /** indexAtNow x the requested tier's multiplier — the tier's FMV. */
  tierValue: number;
  /** The same, projected 7 days forward, for predictedPrice. */
  tierPredicted: number;
  /** The requested tier's own multiplier. */
  requestedMultiplier: number;
  /** Every index point that entered the fit, newest first. */
  points: GradeIndexPoint[];
  /** Per-tier contribution, for the wire's pricingSourceMeta. */
  contributions: GradeIndexTierContribution[];
  /** Sales the identity holds that could NOT be indexed (no multiplier). */
  skipped: Array<{ tier: string; sampleCount: number }>;
  /** How many of the points are the REQUESTED tier's own sales. */
  ownTierPoints: number;
  /** The index trend, %/week, from the fit. */
  trendPctPerWeek: number;
  trendDirection: "up" | "down" | "flat";
  /** The leading-edge fit's own diagnostics, for the projection note. */
  anchorIndexPrice: number;
  anchorAgeDays: number;
  slopeNote: "fit" | "no-fit" | "insane-fit";
  cap: "none" | "newest-band";
}

/** A sale as this module needs it: a price, a date and a tier label. */
export interface GradeIndexSale {
  tier: string;
  price: number;
  soldAt: string;
}

/**
 * Build and project the card's grade-free index, then read the requested
 * tier off it.
 *
 * `multiplierFor` is the empirical lookup, injected so this module never
 * reaches for a table itself: the caller supplies the SAME (family, sport)
 * scoped GRADE_CALIBRATION reader every other cross-tier path uses, and a
 * tier it cannot cover returns null and is skipped. Returns null — not a
 * fabricated number — whenever the rung's preconditions do not hold, so the
 * caller falls through to the rung it would otherwise have taken.
 */
export function projectGradeIndex(
  sales: ReadonlyArray<GradeIndexSale>,
  requestedTier: string,
  multiplierFor: (tier: string) => number | null,
  opts: { nowMs: number; minPool?: number; halfLifeDays?: number },
): GradeIndexProjection | null {
  const minPool = opts.minPool ?? EXACT_POOL_INDEX_MIN_POOL;
  const halfLifeDays = opts.halfLifeDays ?? EXACT_POOL_INDEX_HALF_LIFE_DAYS;

  // The requested tier must itself be indexable — without ITS multiplier
  // there is no way back from the index to a price at this grade, and
  // guessing one is exactly the fabricated-multiplier failure the
  // empirical-only doctrine forbids.
  const requestedMultiplier = multiplierFor(requestedTier);
  if (requestedMultiplier === null || !Number.isFinite(requestedMultiplier) || requestedMultiplier <= 0) {
    return null;
  }

  const points: GradeIndexPoint[] = [];
  const skippedByTier = new Map<string, number>();
  const multByTier = new Map<string, number>();
  for (const s of sales) {
    const price = Number(s.price);
    const t = Date.parse(String(s.soldAt ?? ""));
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(t)) continue;
    let mult = multByTier.get(s.tier);
    if (mult === undefined) {
      const looked = multiplierFor(s.tier);
      mult = looked !== null && Number.isFinite(looked) && looked > 0 ? looked : NaN;
      multByTier.set(s.tier, mult);
    }
    if (!Number.isFinite(mult)) {
      // An uncovered tier is DROPPED, never defaulted to 1x. Treating an
      // unknown grader as raw would quietly enter a slabbed sale into the
      // index at its full graded price and pull the whole card up.
      skippedByTier.set(s.tier, (skippedByTier.get(s.tier) ?? 0) + 1);
      continue;
    }
    points.push({ tier: s.tier, price, soldAt: String(s.soldAt), multiplier: mult, indexPrice: price / mult });
  }

  // The floor is measured on the INDEXABLE pool — the sales that actually
  // reach the fit — not on the raw row count, so a card whose rows are mostly
  // uncovered tiers cannot claim a card-wide trend it does not have.
  if (points.length < minPool) return null;

  // CF-THE-INDEX-NEEDS-A-SECOND-TIER (2026-09-13). The rung exists to let a
  // thin tier learn from its card's OTHER grades. When every sale is already
  // the requested tier's own, there is no other grade to learn from: dividing
  // the tier's sales by its multiplier and multiplying the answer back by the
  // same multiplier returns the level unchanged, so the only thing this rung
  // would do is REPLACE the tier-native aggregation (the 4-7 leading edge,
  // R25's last sale) with a different one, under a label claiming a
  // cross-tier basis it does not have.
  //
  // Caught by `unifiedGradeEntryRungLabel.test.ts`'s five-PSA-10-sales
  // fixture, which is a single-tier card: the rung fired, the number was
  // identical, and only the label changed — a silent relabel of an untouched
  // price, which is exactly the kind of drift the closed rung vocabulary
  // exists to prevent. A tier alone on its card keeps the rung it had.
  if (new Set(points.map((p) => p.tier)).size < 2) return null;

  const atNow = projectFromLeadingEdge(
    points.map((p) => ({ price: p.indexPrice, soldDate: p.soldAt })),
    { forwardDays: 0, nowMs: opts.nowMs, halfLifeDays },
  );
  if (!atNow || !(atNow.nextSaleValue > 0)) return null;
  const at7d = projectFromLeadingEdge(
    points.map((p) => ({ price: p.indexPrice, soldDate: p.soldAt })),
    { forwardDays: 7, nowMs: opts.nowMs, halfLifeDays },
  );

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const indexAtNow = atNow.nextSaleValue;
  const perWeek = Math.round((atNow.slopePerMonthPct / (30 / 7)) * 10) / 10;

  const contributions: GradeIndexTierContribution[] = [];
  const byTier = new Map<string, GradeIndexPoint[]>();
  for (const p of points) {
    let arr = byTier.get(p.tier);
    if (!arr) { arr = []; byTier.set(p.tier, arr); }
    arr.push(p);
  }
  for (const [tier, ps] of byTier) {
    contributions.push({ tier, sampleCount: ps.length, multiplier: ps[0].multiplier });
  }
  contributions.sort((a, b) => b.sampleCount - a.sampleCount || a.tier.localeCompare(b.tier));

  return {
    indexAtNow: r2(indexAtNow),
    tierValue: r2(indexAtNow * requestedMultiplier),
    tierPredicted: r2((at7d?.nextSaleValue ?? indexAtNow) * requestedMultiplier),
    requestedMultiplier,
    points: points.slice().sort((a, b) => Date.parse(b.soldAt) - Date.parse(a.soldAt)),
    contributions,
    skipped: [...skippedByTier.entries()].map(([tier, sampleCount]) => ({ tier, sampleCount })),
    ownTierPoints: byTier.get(requestedTier)?.length ?? 0,
    trendPctPerWeek: perWeek,
    trendDirection: Math.abs(perWeek) < 1 ? "flat" : perWeek > 0 ? "up" : "down",
    anchorIndexPrice: atNow.anchorPrice,
    anchorAgeDays: atNow.anchorAgeDays,
    slopeNote: atNow.slopeNote,
    cap: atNow.cap,
  };
}

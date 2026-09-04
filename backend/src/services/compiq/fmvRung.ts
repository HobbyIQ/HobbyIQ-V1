/**
 * CF-RUNG-LABEL (D4 "one valuation path", PR 1 — 2026-08-29).
 *
 * The machine-readable name of the RUNG that produced a price: which pool
 * the number came from, and how it was read. It is written by the engine
 * that decided the price and carried, unchanged, onto the persisted holding
 * (`fmvRung`), the unified result (`rungLabel`), and the canonical-fmv
 * response (`rungLabel`). Consumers — the divergence digest, telemetry,
 * iOS — read this field. They never infer the rung from a basis note.
 *
 * Why it exists: the #1342 digest gate had to decide "did this price come
 * from the exact-identity pool?" and the only evidence on a holding was
 * prose (`estimateBasis` starting "unified:", or containing "exact-pool
 * supremacy"). Prose is not a contract — #1400 found the gate had been
 * silent for a day because the one method field it trusted had no writer.
 *
 * The vocabulary is CLOSED. Adding a rung means adding it here.
 *
 *   exact-pool-*   the price was read from the pool of the EXACT
 *                  (identity, grade) — the only rungs the digest admits.
 *   everything else is a fallback rung: a neighbouring parallel, a family
 *                  baseline, a multiplier off another grade, a model. A
 *                  divergence produced by one of these is an engine bug
 *                  report, never a user notification.
 */
import type { CanonicalFmvMethod } from "./canonicalFmv.service.js";
import type { HobbyIqFmvMethod } from "../portfolioiq/hobbyIqFmv.service.js";

/** Rungs that read the exact (identity, grade) pool, by aggregation. */
export type ExactPoolRungLabel =
  /** The trend projection over the exact pool, evaluated at now (n >= 8 in
   *  unified, n >= 3 in canonical / hobbyIqFmv). The doctrine rung. D22
   *  (CF-THE-PROJECTION-IS-THE-LEADING-EDGE): in unified the level is the
   *  recency-weighted leading edge at its own time and the window's trend
   *  moves it forward from there — never from the window's median. */
  | "exact-pool-projection"
  /** Newest exact sale: canonical / hobbyIqFmv when n < 3 (drift-adjusted
   *  by the broader trend since it sold); unified when the widest window
   *  holds exactly ONE sale, or when one sale carries a thin window and
   *  disagrees with its leading edge under ONE_SALE_WINDOW_POLICY=last-sale
   *  — the default, Drew's ruling: the latest sale is the market (D22). */
  | "exact-pool-last-sale"
  /** Median of the newest three exact sales (unified, 4 <= n < 8) — and,
   *  since D22, the widest window's leading edge (newest <= 3) when a thin
   *  window's one carrying sale disagrees with it under the named
   *  alternative ONE_SALE_WINDOW_POLICY=widen (off). */
  | "exact-pool-leading-edge"
  /** Recency-weighted median of the exact pool (unified, n < 4 — the last
   *  resort; the basis note already exposes it). Since D22 it stands only
   *  when no single sale carries the window, or the carrying sale agrees
   *  with the leading edge. */
  | "exact-pool-weighted-median"
  /** Plain median of the exact pool (hobbyIqFmv's belt-and-braces branch
   *  when the projection returns nothing — logged when it fires). */
  | "exact-pool-median"
  /** observedGradeCurve's own per-grade read of the exact pool, carried
   *  forward by the player-momentum trajectory (the tile value when the
   *  unified overlay did not reach that tier). */
  | "exact-pool-trajectory";

/** Every rung any engine can name. */
export type FmvRungLabel =
  | ExactPoolRungLabel
  /** unified: the requested grade had no pool entry, so the largest other
   *  grade's pool was rescaled by a grader premium (CF-UNIFIED-GRADE-
   *  FALLBACK-CHAIN). Real sales, wrong grade — a fallback rung. */
  | "cross-grade-fallback"
  /** observedGradeCurve: a tier with no sales of its own, filled from an
   *  observed anchor x empirical grade ratio (or a reference price). The
   *  entry's `estimatedSource` names the mechanism. */
  | "grade-curve-estimate"
  /** CF-GRADED-POOL-INVERSE (Drew, 2026-08-31): "we should be able to price
   *  from graded cards to raw if it is unavailable with empirical data."
   *  The RAW/parent tier had no pool, so this identity's OWN graded children
   *  priced it — the best-evidenced graded tier's projection DIVIDED by that
   *  tier's empirical GRADE_CALIBRATION multiplier. The exact inverse of the
   *  raw→graded fill, on the same byTier / per-sport tables.
   *
   *  It is its own label rather than `grade-curve-estimate` because its
   *  provenance is different in the way that matters to a reader: the number
   *  came from real sales OF THIS CARD (at another grade), not from a
   *  neighbouring identity or a family baseline. Same identity only — never a
   *  different card number, never cross-auto. Still a fallback rung: real
   *  sales, wrong grade, so `isExactPoolRung` is false and the divergence
   *  digest does not notify on it. */
  | "graded-pool-inverse"
  /** CF-PLAYER-TREND-SPECULATION (Drew, 2026-09-02): "this is where
   *  speculation comes from." This card's own pool went COLD (newest comp
   *  older than STALE_COMP_DAYS) and its own trend was UNMEASURABLE, so its
   *  last REAL sale was carried forward on the PLAYER's market:
   *
   *      value = lastRealComp × playerIndex(today) / playerIndex(compDate)
   *
   *  The index is #1644's fixed-liquid-basket math (capped weights,
   *  mix-shift immune, per-card v() = that card's own projected next sale)
   *  scoped to ONE PLAYER's liquid cards and read at two times over one
   *  frozen basket. Reached ONLY when the two rungs above it decline — a
   *  fresh pool, or a measurable own-trend, both beat it, because a player
   *  index is a proxy and a proxy never outranks the thing it proxies for.
   *
   *  A fallback rung, not an exact-pool one: the ANCHOR is a real sale of
   *  this exact card at this exact tier, but the number served is that
   *  anchor moved by OTHER cards' sales, so the digest must not notify on a
   *  divergence it produces. Past 180 days of anchor age the basis says
   *  "speculative" in those words and confidence is floored to that tier. */
  | "player-index-projection"
  /** siblingCardPriceFallback (D4 PR 5): ANOTHER card — the same player's
   *  Base Auto / Base card — × the measured parallel premium. A model over
   *  a different identity; persisted only when the holding's own exact
   *  pool is empty (exactPoolSupremacy.ts). Never an exact-pool rung. */
  | "sibling-estimate"
  | Exclude<CanonicalFmvMethod, "direct-comp">
  | Exclude<HobbyIqFmvMethod, "direct-slug">;

const EXACT_POOL_PREFIX = "exact-pool-";

/** True iff the label names a rung that read the exact (identity, grade)
 *  pool. Unknown / missing labels are NOT exact-pool: a consumer that has
 *  no label falls back to whatever evidence it had before, it does not
 *  get to assume the best case. */
export function isExactPoolRung(label: unknown): label is ExactPoolRungLabel {
  return typeof label === "string" && label.startsWith(EXACT_POOL_PREFIX);
}

/** The rung label for a canonical-fmv result. `direct-comp` IS the exact
 *  pool; its aggregation is whichever branch projectNextSaleFromComps
 *  took. Every other canonical method is already a rung name. */
export function canonicalRungLabel(
  method: CanonicalFmvMethod,
  projectionMethod?: "linear-regression" | "trend-adjusted-last-sale" | null,
): FmvRungLabel {
  if (method === "direct-comp") {
    return projectionMethod === "trend-adjusted-last-sale"
      ? "exact-pool-last-sale"
      : "exact-pool-projection";
  }
  return method;
}

/** The rung label for a hobbyIqFmv ladder result. `direct-slug` IS the
 *  exact pool; its aggregation is the projection branch (or the plain
 *  median when the projection returned nothing). Every other ladder rung
 *  is already a rung name. */
export function hobbyIqRungLabel(
  method: HobbyIqFmvMethod,
  aggregation: "linear-regression" | "trend-adjusted-last-sale" | "median" | null,
): FmvRungLabel {
  if (method === "direct-slug") {
    if (aggregation === "trend-adjusted-last-sale") return "exact-pool-last-sale";
    if (aggregation === "median") return "exact-pool-median";
    return "exact-pool-projection";
  }
  return method;
}

/**
 * CF-THE-LADDER-IS-THE-VOCABULARY (Drew, 2026-09-04).
 *
 * The vocabulary as a RUNTIME value, not only as a type.
 *
 * The type union above is a compile-time contract: it stops an engine from
 * inventing a rung name. It cannot stop a CONSUMER from admitting only some
 * of the rungs the engine may legitimately return, because a hardcoded
 * subset type-checks perfectly — every member of a subset is a member of the
 * union.
 *
 * That is exactly what happened. `holdingValuation.ts` — the portfolio
 * persist site — admitted two rungs by name:
 *
 *     const observed  = priced && valueSource === "observed" && isExactPoolRung(rungLabel);
 *     const estimated = priced && valueSource === "estimated" && rungLabel === "grade-curve-estimate";
 *     if (!observed && !estimated) return { outcome: "unpriced", valuation: v };
 *
 * `player-index-projection` shipped in #1647 on 2026-09-02, the ladder began
 * returning it, and every holding it priced fell through that `if` as
 * "unpriced" — a priced valuation discarded by the layer whose only job is
 * to persist it. Holding 0a9afe09 (Cam Caminiti CPA-CC Blue Refractor /150)
 * valued at $215.17 live and showed no price at all, because the persist
 * gate had never heard of the rung the ladder had learned.
 *
 * The lesson is not "add player-index-projection to the list". Every rung
 * added after this one would fail the same way, silently, and the failure
 * mode is a card with no price — the worst thing this product can show. So
 * the persist layer no longer keeps a list: it asks the vocabulary. A rung
 * the vocabulary names is a rung the persist layer accepts, by construction.
 *
 * Adding a rung means adding it in TWO places in this file — the type and
 * this array — and the exhaustiveness assertion below fails the BUILD if the
 * two ever disagree, so the array cannot silently fall behind the type.
 */
export const FMV_RUNG_LABELS = [
  // Exact-pool rungs (the digest's notify set).
  "exact-pool-projection",
  "exact-pool-last-sale",
  "exact-pool-leading-edge",
  "exact-pool-weighted-median",
  "exact-pool-median",
  "exact-pool-trajectory",
  // Fallback rungs named in this file.
  "cross-grade-fallback",
  "grade-curve-estimate",
  "graded-pool-inverse",
  "player-index-projection",
  "sibling-estimate",
  // CanonicalFmvMethod, minus `direct-comp` (which IS the exact pool and is
  // named by its aggregation above).
  "cross-parallel",
  "neighbor-parallel",
  "sibling-parallel",
  "hot-raw-same-card-anchor",
  "family-baseline",
  "product-tier",
  "tiered-momentum-card",
  "tiered-momentum-player",
  // HobbyIqFmvMethod, minus `direct-slug` (likewise the exact pool).
  "cross-setkey",
  "cross-printrun",
  "same-printrun-cross-parallel",
  "printrun-discovery",
  "grade-cross-raw",
  "composite-neighbor",
  "rare-card-anchor",
  // The engine's own refusal. It is IN the vocabulary — a rung label is
  // required on every Valuation — but it names NO price, so a persist gate
  // must exclude it explicitly rather than by forgetting it.
  "no-basis",
] as const satisfies ReadonlyArray<FmvRungLabel>;

/** Compile-time exhaustiveness: every member of the type appears in the
 *  array. If a rung is added to `FmvRungLabel` and not to `FMV_RUNG_LABELS`,
 *  this assignment fails to compile — the array cannot fall behind. */
type _EveryRungIsListed = FmvRungLabel extends (typeof FMV_RUNG_LABELS)[number] ? true : never;
const _everyRungIsListed: _EveryRungIsListed = true;
void _everyRungIsListed;

const RUNG_SET: ReadonlySet<string> = new Set<string>(FMV_RUNG_LABELS);

/** True iff the label is a rung the ladder's vocabulary names. */
export function isFmvRungLabel(label: unknown): label is FmvRungLabel {
  return typeof label === "string" && RUNG_SET.has(label);
}

/**
 * True iff the label names a rung that produced a PRICE — the vocabulary
 * minus the engine's own refusal.
 *
 * This is the predicate a persist layer wants: "did the ladder price this?"
 * `no-basis` is a real member of the vocabulary and must not be persisted as
 * a value, so it is excluded here once, by name, rather than at every
 * consumer that would otherwise have to remember.
 */
export function isPricingRung(label: unknown): label is Exclude<FmvRungLabel, "no-basis"> {
  return isFmvRungLabel(label) && label !== "no-basis";
}

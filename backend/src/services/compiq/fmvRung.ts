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

// CF-PHASE5-V2-ZERO-COMP-ANCHOR (2026-07-10, Drew — all_baseball_cards_
// roadmap Phase 5 v2). Fixes the Hartman-class "can't estimate yet"
// state where the specific player has ZERO comps but the ladder floor
// could still produce an honest structural minimum from a broader
// anchor.
//
// ──── Problem ─────────────────────────────────────────────────────────────
//
// parallel-floor-projection needs a base median to multiply by the
// print-run-tier multiplier. Today's anchor is `fetchCompsByPlayer(player,
// product, year)` — for prospects like Eric Hartman with no CH catalog
// presence yet, that returns 0 comps and the path bails to null.
//
// The ladder is still meaningful though: a 2025 Bowman Draft Chrome
// Gold /50 is worth SOMETHING even if the specific player has never
// sold. What's needed is a coarser anchor that says "at product-year
// level, base cards trade around $X."
//
// ──── Solution ────────────────────────────────────────────────────────────
//
// `fetchProductYearMedianAnchor(product, cardYear)` — median price of
// the top-K non-parallel-annotated search results for `(year, product)`
// on CardHedge. Bypasses the per-player filter by passing an empty
// playerName to fetchCompsByPlayer, which then builds its search query
// as just [year, product].join(" ").
//
// This is a coarser anchor:
//   * SPECIFICITY:  player-scoped median >>  product-year median
//   * COVERAGE:     player-scoped median <<  product-year median
//
// So it fires only as a FALLBACK when the player-scoped anchor is
// empty — never overriding a real player-scoped result.
//
// ──── Confidence downgrade ────────────────────────────────────────────────
//
// A ladder projection anchored at the product-year level is by
// construction less accurate than one anchored at the player level.
// Callers should downgrade `pricingConfidence` and widen the range
// (e.g. ±50% instead of ±25%) when this anchor drives the estimate.
//
// ──── Ops safety ──────────────────────────────────────────────────────────
//
// Reuses fetchCompsByPlayer's cache — same 6h aggregate cache lives
// server-side. The empty-playerName cache key doesn't collide with real
// player queries. Env flag COMPIQ_PRODUCT_YEAR_ANCHOR_ENABLED (default
// false) — flag off = zero behavior change from Phase 5 v1 today.

import { fetchCompsByPlayer } from "./compsByPlayer.service.js";
import { projectNextSaleFromComps } from "./nextSaleProjection.service.js";

export interface ProductYearAnchorResult {
  // CF-NO-MEDIAN-FMV (Drew, 2026-07-15): `median` field name is preserved
  // for downstream call-site parity but now carries the trend-projected
  // next-sale value across the product-year cross-player pool — NOT an
  // arithmetic median. Emission call-sites already forward it into a
  // parallel-multiplier product; the trend-projected anchor is the
  // structurally honest input Drew's rule demands.
  median: number;
  /** How many comps went into the projection — surfaced for confidence. */
  compCount: number;
  /** Distinct card-id count in the pool — dispersion signal. */
  distinctCardIds: number;
  /** Source label for attribution + logging. */
  source: "product-year-anchor";
}

/**
 * Compute the product-year cross-player median anchor. Returns null when:
 *   * env flag is off
 *   * inputs are incomplete
 *   * CardHedge returns no candidates for the (year, product) query
 *   * every candidate returns no trusted comps
 *
 * Never throws. Callers fall through to the existing null-return path
 * on a null return.
 */
export async function fetchProductYearMedianAnchor(
  product: string | null | undefined,
  cardYear: number | null | undefined,
): Promise<ProductYearAnchorResult | null> {
  if (process.env.COMPIQ_PRODUCT_YEAR_ANCHOR_ENABLED !== "true") return null;
  if (!product || typeof product !== "string" || !product.trim()) return null;
  if (!cardYear || !Number.isFinite(cardYear)) return null;

  try {
    // Empty playerName drops the player filter from fetchCompsByPlayer's
    // CH search query. See compsByPlayer.service.ts:167 — the query is
    // built as `[yearToken, playerName, product].filter(Boolean).join(" ")`,
    // so an empty player becomes just `${year} ${product}`.
    const pool = await fetchCompsByPlayer({
      playerName: "",
      product: product.trim(),
      cardYear,
    });
    const validComps = (pool.comps ?? [])
      .filter((c) => Number.isFinite(c.price) && c.price > 0);
    if (validComps.length === 0) return null;

    // CF-NO-MEDIAN-FMV (Drew, 2026-07-15): projected next-sale replaces
    // the arithmetic median across the product-year cross-player pool.
    // Regression fires when ≥2 distinct dates exist; trend-adjusted-last-
    // sale otherwise. Both project a next sale — never a middle price.
    const nextSale = projectNextSaleFromComps(
      validComps.map((c) => ({ price: c.price, soldDate: c.date })),
    );
    if (nextSale === null) return null;

    const distinctCardIds = new Set(
      validComps.map((c) => c.cardId).filter(Boolean),
    ).size;

    return {
      median: nextSale.nextSaleValue,
      compCount: validComps.length,
      distinctCardIds,
      source: "product-year-anchor",
    };
  } catch (err) {
    console.warn(
      `[productYearAnchor] fetch failed for (${product}, ${cardYear}):`,
      (err as Error)?.message ?? err,
    );
    return null;
  }
}

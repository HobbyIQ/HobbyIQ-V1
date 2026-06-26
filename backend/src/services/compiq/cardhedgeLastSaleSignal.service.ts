/**
 * CF-CH-LAST-SALE-MODEL-EXPECTATION (2026-06-26): compute a multiplier-
 * model expectation for the cardhedge-last-sale path, and classify the
 * single trusted CH sale against the curated parallel premium range as a
 * Lean Buy / Hold / Lean Sell signal.
 *
 * Closes the two gaps the prior recon identified:
 *
 *   GAP A — subset resolution. The CH-served pinned path's identity
 *           reads `set: ctx.product` ("Bowman"), but the curated
 *           multiplier table indexes by SUBSET ("Chrome Prospect
 *           Autographs"). This module resolves the real subset via
 *           getCardDetail(cardsightCardId).setName, which Cardsight
 *           returns with the precise subset string (e.g. "Chrome
 *           Prospects Autographs" — the engine table normalizes the
 *           plural→singular through cardsightSubsetNormalizer).
 *
 *   GAP B — Build B was never wired into the cardhedge-last-sale arm.
 *           It exists only inside the variant-mismatch branch (bypassed
 *           by trust-CH) and the T3 collision branch (trust-CH forces
 *           T0). This module calls computeBaseAnchoredParallelFMV with
 *           the resolved subset + base-auto comps from the parent
 *           card's CS pricing pool.
 *
 * Signal classification (Drew's spec, owner-locked 2026-06-26):
 *   effectiveMultiplier = lastSale.price / baseAutoMedian
 *   compared to the curated row's baseRelativePremium.range:
 *     - effectiveMultiplier > range.high  → "sell" (above expected band)
 *     - effectiveMultiplier < range.low   → "buy"  (below expected band)
 *     - within [range.low, range.high]    → "hold"
 *
 * Equivalent in price space: compare lastSale.price to Build B's
 * estimateLow/estimateHigh, which is `baseAutoMedian × range.low/high`.
 *
 * SCOPE GUARANTEE: this module is invoked ONLY when the engine has
 * decided the response is `estimateSource === "cardhedge-last-sale"`.
 * Every other source path is untouched. When Build B can't compute (no
 * curated row, no empirical baseRelativePremium, insufficient base
 * autos, subset unresolvable), this returns null and the caller emits
 * the existing cardhedge-last-sale shape without modelExpectation /
 * modelSignal — no fake signals, no crashes.
 *
 * FMV STAYS NULL: this is a SIGNAL surface, not a FMV. The
 * cardhedge-last-sale invariant (fairMarketValue = null) is preserved.
 */

import { getPricing, getCardDetail } from "./cardsight.client.js";
import { normalizeCardsightSetName } from "./cardsightSubsetNormalizer.js";
import {
  lookupBowmanFamilyEntry,
  type BowmanFamilyProduct,
  type BaseRelativePremium,
} from "./chromeDraftMultipliers.js";
import {
  computeBaseAnchoredParallelFMV,
  type BaseAnchoredFmvResult,
} from "../../agents/baseAnchoredParallelFMV.js";

/**
 * Surfaced on the engine response when the signal computes successfully.
 * The value is the price-space centroid (baseRawMedian × multiplier);
 * the range is the price-space [low, high] from baseRawMedian ×
 * baseRelativePremium.range. Surfacing both lets iOS render the signal
 * with explicit numbers ("model expects \$244 (range \$182–\$311)") rather
 * than just a verdict badge.
 */
export interface ModelExpectation {
  /** Price-space centroid: baseRawMedian × baseRelativePremium.value. */
  value: number;
  /** Price-space range: [baseRawMedian × range.low, baseRawMedian × range.high]. */
  range: [number, number];
  /** Empirical multiplier from the curated row (e.g. 2.974 for BXF /150). */
  multiplier: number;
  /** Multiplier range (e.g. [2.214, 3.795] for BXF /150). */
  multiplierRange: [number, number];
  /** Build B's emit basis — "base_anchored_paired_premium" or off-sample variant. */
  basis: BaseAnchoredFmvResult["estimateBasis"];
  /** Sample count behind the empirical premium (e.g. n=9 for BXF /150). */
  n: number;
  /** The holding's own base-auto median ($/sale) — the anchor of the comparison. */
  baseAutoMedian: number;
  /** Sample count behind baseAutoMedian. */
  baseAutoCount: number;
}

export interface ModelSignal {
  /** Buy/Hold/Sell verdict from the single comp vs the curated range. */
  lean: "buy" | "hold" | "sell";
  /**
   * Percentage delta of the sale from the model's centroid expectation:
   *   (lastSale.price - modelExpectation.value) / modelExpectation.value × 100
   * Positive = above model, negative = below. e.g. lastSale \$450 vs
   * expectation \$244 → +84.4.
   */
  deltaPct: number;
  /** The model's centroid expectation ($) — same as modelExpectation.value, surfaced for convenience. */
  expectation: number;
  /** The effective multiplier observed in the sale: lastSale.price / baseAutoMedian. */
  effectiveMultiplier: number;
}

export interface ComputeCardhedgeLastSaleSignalParams {
  cardsightCardId: string;
  lastSalePrice: number;
  product: BowmanFamilyProduct;
  parallelName: string;
  year: number;
}

export interface CardhedgeLastSaleSignalResult {
  modelExpectation: ModelExpectation;
  modelSignal: ModelSignal;
}

/**
 * Internal: client-injection seam so unit tests can stub the two
 * Cardsight fetches without going through vi.mock for the entire module
 * graph. Production callers omit `clients` and the helper falls back to
 * the module-level imports.
 */
export interface CardhedgeLastSaleSignalClients {
  getCardDetail?: typeof getCardDetail;
  getPricing?: typeof getPricing;
}

/**
 * Best-effort: returns a populated signal when the gate chain passes,
 * otherwise null. Never throws — every async failure caught + logged.
 * Caller emits the cardhedge-last-sale shape unchanged on null.
 */
export async function computeCardhedgeLastSaleSignal(
  params: ComputeCardhedgeLastSaleSignalParams,
  clients: CardhedgeLastSaleSignalClients = {},
): Promise<CardhedgeLastSaleSignalResult | null> {
  const _getCardDetail = clients.getCardDetail ?? getCardDetail;
  const _getPricing = clients.getPricing ?? getPricing;

  if (
    !params.cardsightCardId ||
    !Number.isFinite(params.lastSalePrice) ||
    params.lastSalePrice <= 0
  ) {
    return null;
  }

  // ─── Gap A: subset resolution via getCardDetail ─────────────────────
  let setName: string | null = null;
  try {
    const detail = await _getCardDetail(params.cardsightCardId);
    if (!detail || detail.notFound) return null;
    setName =
      typeof detail.setName === "string" && detail.setName.trim().length > 0
        ? detail.setName.trim()
        : null;
  } catch {
    return null;
  }
  const subset = normalizeCardsightSetName(setName);
  if (!subset) return null;

  // Strip print-run suffix ("/150", "/99", "/1") before the curated-table
  // lookup. The table keys by canonical parallelName ("Blue X-Fractor")
  // and stores printRun separately as metadata; inputs carrying the print
  // run (the holding's stored "Blue X-Fractor /150" or normalizedParallel's
  // "blue x fractor 150") would otherwise miss the row.
  const parallelNameForLookup = params.parallelName
    .replace(/\s*\/\s*\d+\s*$/, "")
    .trim();
  if (!parallelNameForLookup) return null;

  // ─── Gate: curated row + empirical baseRelativePremium ───────────────
  const row = lookupBowmanFamilyEntry({
    product: params.product,
    subset,
    parallelName: parallelNameForLookup,
    year: params.year,
  });
  const premium: BaseRelativePremium | undefined = row?.baseRelativePremium;
  if (!row || !premium || premium.provenance !== "empirical") return null;

  // ─── Gap B: Build B against the base-auto pool ───────────────────────
  // The base autos live in the PARENT card's CS pricing pool. Build B's
  // internal isBaseAutoTitle filter does the title-classification step.
  let baseAutoComps: Array<{ title: string; price: number }> = [];
  try {
    const pricing = await _getPricing(params.cardsightCardId);
    const rawRecords = pricing?.raw?.records ?? [];
    baseAutoComps = rawRecords
      .filter(
        (r) =>
          typeof r?.title === "string" &&
          typeof r?.price === "number" &&
          Number.isFinite(r.price) &&
          r.price > 0,
      )
      .map((r) => ({ title: String(r.title), price: Number(r.price) }));
  } catch {
    return null;
  }
  if (baseAutoComps.length === 0) return null;

  const buildB = computeBaseAnchoredParallelFMV({
    subject: {
      playerName: "",  // Build B doesn't use playerName for its math
      year: params.year,
      product: params.product,
      subset,
      parallelName: parallelNameForLookup,
    },
    comps: baseAutoComps,
  });
  if (
    !buildB.isEstimate ||
    buildB.estimatedValue === null ||
    buildB.estimateLow === null ||
    buildB.estimateHigh === null ||
    buildB.baseAutoMedian === null ||
    buildB.baseAutoMedian <= 0
  ) {
    return null;
  }

  // ─── Signal: classify lastSale against the price-space range ─────────
  // Equivalent in multiplier space:
  //   effectiveMultiplier = lastSale / baseAutoMedian
  //   vs premium.range = [low, high]
  const effectiveMultiplier = params.lastSalePrice / buildB.baseAutoMedian;
  const lean: ModelSignal["lean"] =
    params.lastSalePrice > buildB.estimateHigh
      ? "sell"
      : params.lastSalePrice < buildB.estimateLow
        ? "buy"
        : "hold";
  const deltaPct =
    ((params.lastSalePrice - buildB.estimatedValue) / buildB.estimatedValue) * 100;

  return {
    modelExpectation: {
      value: buildB.estimatedValue,
      range: [buildB.estimateLow, buildB.estimateHigh],
      multiplier: premium.value,
      multiplierRange: premium.range,
      basis: buildB.estimateBasis,
      n: premium.n,
      baseAutoMedian: buildB.baseAutoMedian,
      baseAutoCount: buildB.baseAutoCount,
    },
    modelSignal: {
      lean,
      deltaPct: Math.round(deltaPct * 10) / 10,
      expectation: buildB.estimatedValue,
      effectiveMultiplier: Math.round(effectiveMultiplier * 1000) / 1000,
    },
  };
}

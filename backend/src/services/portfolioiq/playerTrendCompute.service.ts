// CF-PLAYER-TREND (Drew, 2026-07-17). Pure matched-cohort player-
// momentum math. No IO — takes sales, returns numbers.
//
// The algorithm:
//   1. Group sales by (cardId, window). Windows are (recent, prior),
//      each `recentWindowDays` wide.
//   2. Keep only cards where BOTH windows have ≥ minSalesPerWindow
//      sales — the "matched-cohort".
//   3. Per matched card: compute ratio = median(recent) / median(prior).
//   4. Aggregate: momentum = mean of ratios across cards. Equal weight
//      per SKU by design — a $2M superfractor sale doesn't drown out
//      signal from 100 $50 base cards.
//   5. Direction: gate by ±5% momentum for "up"/"down"; flat between.
//   6. Velocity: sum of recent-window sales / (recentWindowDays / 7).
//
// Test-only surfaces are prefixed `_`.

import type {
  PlayerSale,
  PlayerTrendOptions,
  PlayerTrendResult,
  PerCardRatio,
} from "../../types/playerTrend.types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MOMENTUM_UP_THRESHOLD = 1.05;   // +5% aggregate ratio
const MOMENTUM_DOWN_THRESHOLD = 0.95; // -5% aggregate ratio

const DEFAULT_OPTIONS: Required<PlayerTrendOptions> = {
  recentWindowDays: 30,
  priorWindowDays: 30,
  minSalesPerWindow: 3,
  minTotalSales: 4,
  topCardsInResult: 20,
  saleFilter: "all",
};

/** Predicate: does this sale pass the stratification filter?
 *  Absent/empty grader is treated as "Raw" for filter purposes so
 *  older data paths don't accidentally get excluded. */
function passesFilter(grader: string | null | undefined, filter: PlayerTrendOptions["saleFilter"]): boolean {
  if (!filter || filter === "all") return true;
  const g = (grader ?? "Raw").trim();
  const isRaw = g === "" || g.toLowerCase() === "raw";
  return filter === "raw_only" ? isRaw : !isRaw;
}

/** Main entry point. Computes matched-cohort momentum + velocity for a
 *  single player over the sales collection. */
export function computePlayerTrend(
  player: string,
  sales: PlayerSale[],
  opts: PlayerTrendOptions = {},
  now: Date = new Date(),
): PlayerTrendResult {
  const options = resolveOptions(opts);
  const {
    recentWindowDays,
    priorWindowDays,
    minSalesPerWindow,
    minTotalSales,
    topCardsInResult,
  } = options;

  const nowMs = now.getTime();
  const recentCutoff = nowMs - recentWindowDays * MS_PER_DAY;
  const priorCutoff = recentCutoff - priorWindowDays * MS_PER_DAY;

  // Bucket by cardId → { recent: number[], prior: number[], label }
  const buckets = new Map<
    string,
    { recent: number[]; prior: number[]; label: string | null }
  >();

  let totalSalesCounted = 0;
  let recentTotalSales = 0;

  for (const s of sales) {
    if (!Number.isFinite(s.price) || s.price <= 0) continue;
    const t = Date.parse(s.saleDate);
    if (!Number.isFinite(t)) continue;
    if (!passesFilter(s.grader, options.saleFilter)) continue;

    let b = buckets.get(s.cardId);
    if (!b) {
      b = { recent: [], prior: [], label: s.skuLabel ?? null };
      buckets.set(s.cardId, b);
    }
    // First-non-null label wins — sales for the same card_id share a SKU.
    if (b.label === null && s.skuLabel) b.label = s.skuLabel;

    if (t >= recentCutoff && t <= nowMs) {
      b.recent.push(s.price);
      recentTotalSales++;
      totalSalesCounted++;
    } else if (t >= priorCutoff && t < recentCutoff) {
      b.prior.push(s.price);
      totalSalesCounted++;
    }
  }

  // Compute per-card ratios for cards that qualify in BOTH windows.
  const ratios: PerCardRatio[] = [];
  let cardsInPool = 0;
  for (const [cardId, b] of buckets.entries()) {
    if (b.recent.length + b.prior.length > 0) cardsInPool++;
    const total = b.recent.length + b.prior.length;
    if (total < minTotalSales) continue;
    if (b.recent.length < minSalesPerWindow) continue;
    if (b.prior.length < minSalesPerWindow) continue;

    const medianRecent = median(b.recent);
    const medianPrior = median(b.prior);
    if (medianPrior <= 0) continue;

    ratios.push({
      cardId,
      skuLabel: b.label,
      ratio: medianRecent / medianPrior,
      nRecent: b.recent.length,
      nPrior: b.prior.length,
      medianRecent: round(medianRecent, 2),
      medianPrior: round(medianPrior, 2),
    });
  }

  const qualifyingCards = ratios.length;
  const momentum = qualifyingCards > 0 ? mean(ratios.map((r) => r.ratio)) : 1;

  const direction: "up" | "flat" | "down" =
    momentum > MOMENTUM_UP_THRESHOLD ? "up" :
    momentum < MOMENTUM_DOWN_THRESHOLD ? "down" :
    "flat";

  const velocityPerWeek = recentTotalSales / (recentWindowDays / 7);

  const flags: string[] = [];
  if (qualifyingCards < 3) flags.push("sparse");

  // one_card_dominant: does the top-volume card carry > 50% of total?
  if (buckets.size > 0) {
    let maxVolume = 0;
    for (const b of buckets.values()) {
      const v = b.recent.length + b.prior.length;
      if (v > maxVolume) maxVolume = v;
    }
    if (totalSalesCounted > 0 && maxVolume / totalSalesCounted > 0.5) {
      flags.push("one_card_dominant");
    }
  }

  if (qualifyingCards >= 3) {
    const ratioStd = stddev(ratios.map((r) => r.ratio));
    if (ratioStd > 0.5) flags.push("wide_ratio_dispersion");
  }

  // Sort ratios by |ratio - 1| DESC so biggest movers show first.
  ratios.sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1));

  return {
    player,
    computedAt: now.toISOString(),
    momentum: round(momentum, 4),
    direction,
    velocityPerWeek: round(velocityPerWeek, 2),
    cardsInPool,
    qualifyingCards,
    totalSales: totalSalesCounted,
    perCardRatios: ratios.slice(0, topCardsInResult),
    flags,
    options,
  };
}

function resolveOptions(opts: PlayerTrendOptions): Required<PlayerTrendOptions> {
  return {
    recentWindowDays: opts.recentWindowDays ?? DEFAULT_OPTIONS.recentWindowDays,
    priorWindowDays: opts.priorWindowDays ?? DEFAULT_OPTIONS.priorWindowDays,
    minSalesPerWindow: opts.minSalesPerWindow ?? DEFAULT_OPTIONS.minSalesPerWindow,
    minTotalSales: opts.minTotalSales ?? DEFAULT_OPTIONS.minTotalSales,
    topCardsInResult: opts.topCardsInResult ?? DEFAULT_OPTIONS.topCardsInResult,
    saleFilter: opts.saleFilter ?? DEFAULT_OPTIONS.saleFilter,
  };
}

/** CF-STRATIFIED-TRENDS (Drew, 2026-07-17): compute all three variants
 *  in one pass over the input sales. Cheap — same math three times but
 *  the input list is small per player. */
export function computeStratifiedPlayerTrend(
  player: string,
  sales: PlayerSale[],
  opts: PlayerTrendOptions = {},
  now: Date = new Date(),
): import("../../types/playerTrend.types.js").StratifiedPlayerTrendResult {
  return {
    player,
    computedAt: now.toISOString(),
    all: computePlayerTrend(player, sales, { ...opts, saleFilter: "all" }, now),
    raw: computePlayerTrend(player, sales, { ...opts, saleFilter: "raw_only" }, now),
    graded: computePlayerTrend(player, sales, { ...opts, saleFilter: "graded_only" }, now),
  };
}

/** Numerically stable median. Sorts a copy, so caller keeps ownership. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

function round(x: number, digits: number): number {
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

/** Test surfaces. */
export const _MOMENTUM_UP_THRESHOLD = MOMENTUM_UP_THRESHOLD;
export const _MOMENTUM_DOWN_THRESHOLD = MOMENTUM_DOWN_THRESHOLD;
export const _DEFAULT_OPTIONS = DEFAULT_OPTIONS;

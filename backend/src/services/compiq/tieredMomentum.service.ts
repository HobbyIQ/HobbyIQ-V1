// CF-TIERED-MOMENTUM (Drew, 2026-08-03). Card momentum first, if thin
// then player momentum. Reads the identityMethod field emitted by
// persistVendorSalesToPool:
//   - "cardnumber-precise" (or legacy null pre-fix) → card-tier signal
//   - "player-fallback"                             → player-tier signal
//
// When a specific cardId has ≥ MIN_CARD_COMPS in the trailing window,
// we compute momentum from those comps directly. Otherwise fall back
// to the broader (playerName + cardYear + setName + parallel) bucket,
// which INCLUDES player-fallback rows collected when card_catalog
// didn't have the specific cardNumber. Same-player pool is coarser
// but statistically thicker — better than nothing when the exact
// card has 0-3 comps.

import { CosmosClient, type Container } from "@azure/cosmos";

const CARD_TIER_MIN_COMPS = Number(process.env.TIERED_MOMENTUM_CARD_MIN ?? "5");
const WINDOW_DAYS_RECENT = Number(process.env.TIERED_MOMENTUM_WINDOW_RECENT ?? "30");
const WINDOW_DAYS_BASELINE = Number(process.env.TIERED_MOMENTUM_WINDOW_BASELINE ?? "180");

export type MomentumTier = "card" | "player" | "none";

export interface TieredMomentumResult {
  tier: MomentumTier;
  cardId: string;
  hobbyiqCardId: string | null;
  compsWindow: {
    days: number;
    n: number;
    medianPrice: number | null;
    latestPrice: number | null;
    latestSoldAt: string | null;
  };
  baseline: {
    days: number;
    n: number;
    medianPrice: number | null;
  };
  // Fractional change from baseline median to recent median.
  // Positive = trending up. Null when either window is empty.
  momentumRatio: number | null;
  // Projected next-sale price = baseline median × momentum ratio,
  // clamped to [0.5, 2.0] of baseline. Null when momentum can't compute.
  projectedNextSale: number | null;
  attribution: {
    playerName: string | null;
    setKey: string | null;
    cardYear: number | null;
    parallel: string | null;
    // For player-tier fallbacks, how many rows were pf-slugged
    // (i.e. entered pool via the player-fallback identity path).
    playerFallbackRowsIncluded: number;
    // Total rows examined across both windows
    totalRowsScanned: number;
  };
}

let cachedContainer: Container | null = null;
async function getSoldCompsContainer(): Promise<Container | null> {
  if (cachedContainer) return cachedContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    cachedContainer = client
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container("sold_comps");
    return cachedContainer;
  } catch {
    return null;
  }
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function clampProjection(baseline: number, ratio: number): number {
  const capped = Math.max(0.5, Math.min(2.0, ratio));
  return Math.round(baseline * capped * 100) / 100;
}

interface CompRow {
  price: number;
  soldAt: string;
  identityMethod?: string | null;
}

type QueryParam = { name: string; value: string | number | boolean | null };

// POOL-1 residue (audit, 2026-09-03). Momentum read sold_comps directly rather
// than through exactPoolReader, so it inherited none of that reader's
// adjudication filter: a row already marked `flaggedWrong` / `excludedFromFmv`
// still entered BOTH the card tier and the player-tier fallback, moving a
// published momentum ratio with evidence the pool had already thrown out.
//
// Applied inside queryComps rather than at the two call sites on purpose --
// this function is the single door both tiers go through, so a future third
// tier cannot be added without the filter.
//
// Same store-form predicate as exactPoolReader:84-85: `!= true` rather than
// `= false`, with the NOT IS_DEFINED disjunct that keeps the overwhelming
// majority of rows (which carry neither flag) in the sample.
const ADJUDICATION_FILTER =
  "(NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true)"
  + " AND (NOT IS_DEFINED(c.excludedFromFmv) OR c.excludedFromFmv != true)";

async function queryComps(
  cont: Container,
  where: string,
  parameters: QueryParam[],
): Promise<CompRow[]> {
  try {
    const { resources } = await cont.items
      .query<CompRow>({
        query: `SELECT c.price, c.soldAt, c.identityMethod FROM c WHERE ${where} AND ${ADJUDICATION_FILTER}`,
        parameters,
      }, { maxItemCount: 500 })
      .fetchAll();
    return (resources || []).filter((r) => typeof r.price === "number" && r.price > 0 && r.soldAt);
  } catch {
    return [];
  }
}

function splitWindow(rows: CompRow[], recentCutoffIso: string, baselineCutoffIso: string) {
  const recent: number[] = [];
  const baseline: number[] = [];
  let latestPrice: number | null = null;
  let latestSoldAt: string | null = null;
  let playerFallbackCount = 0;
  for (const r of rows) {
    if (r.identityMethod === "player-fallback") playerFallbackCount++;
    if (r.soldAt >= recentCutoffIso) recent.push(r.price);
    if (r.soldAt >= baselineCutoffIso) baseline.push(r.price);
    if (!latestSoldAt || r.soldAt > latestSoldAt) {
      latestSoldAt = r.soldAt;
      latestPrice = r.price;
    }
  }
  return { recent, baseline, latestPrice, latestSoldAt, playerFallbackCount };
}

/**
 * Compute tiered momentum for a specific card.
 *
 * @param cardId The canonical cardId (hobbyiqCardId or vendor cardId that
 *               maps to a hobbyiqCardId). Callers should resolve to the
 *               canonical form before calling.
 * @param opts.identityHint  When cardId is not enough to fall back to the
 *               player tier — provide playerName, cardYear, setName, parallel
 *               so the fallback pool query is well-formed.
 */
export async function computeTieredMomentum(
  cardId: string,
  opts: {
    hobbyiqCardId?: string | null;
    identityHint?: {
      playerName?: string | null;
      cardYear?: number | null;
      setName?: string | null;
      parallel?: string | null;
      sport?: string | null;
    };
  } = {},
): Promise<TieredMomentumResult> {
  const cont = await getSoldCompsContainer();
  const now = Date.now();
  const recentCutoff = new Date(now - WINDOW_DAYS_RECENT * 86400_000).toISOString();
  const baselineCutoff = new Date(now - WINDOW_DAYS_BASELINE * 86400_000).toISOString();
  const hobbyiqCardId = opts.hobbyiqCardId ?? (cardId.startsWith("hiq:") ? cardId : null);
  const hint = opts.identityHint ?? {};

  const empty: TieredMomentumResult = {
    tier: "none",
    cardId,
    hobbyiqCardId,
    compsWindow: { days: WINDOW_DAYS_RECENT, n: 0, medianPrice: null, latestPrice: null, latestSoldAt: null },
    baseline: { days: WINDOW_DAYS_BASELINE, n: 0, medianPrice: null },
    momentumRatio: null,
    projectedNextSale: null,
    attribution: {
      playerName: hint.playerName ?? null,
      setKey: hint.setName ?? null,
      cardYear: hint.cardYear ?? null,
      parallel: hint.parallel ?? null,
      playerFallbackRowsIncluded: 0,
      totalRowsScanned: 0,
    },
  };
  if (!cont) return empty;

  // Card tier: exact cardId or hobbyiqCardId, cardnumber-precise or legacy null only
  const cardTierRows = await queryComps(
    cont,
    "(c.cardId = @cid OR c.hobbyiqCardId = @hiq) AND c.soldAt >= @base AND (c.identityMethod = 'cardnumber-precise' OR NOT IS_DEFINED(c.identityMethod) OR c.identityMethod = null)",
    [
      { name: "@cid", value: cardId },
      { name: "@hiq", value: hobbyiqCardId ?? cardId },
      { name: "@base", value: baselineCutoff },
    ],
  );

  const cardSplit = splitWindow(cardTierRows, recentCutoff, baselineCutoff);
  const cardRecentN = cardSplit.recent.length;
  const cardBaselineN = cardSplit.baseline.length;

  if (cardRecentN >= CARD_TIER_MIN_COMPS) {
    const recentMedian = median(cardSplit.recent);
    const baselineMedian = median(cardSplit.baseline);
    const ratio = recentMedian && baselineMedian ? recentMedian / baselineMedian : null;
    return {
      tier: "card",
      cardId,
      hobbyiqCardId,
      compsWindow: {
        days: WINDOW_DAYS_RECENT,
        n: cardRecentN,
        medianPrice: recentMedian,
        latestPrice: cardSplit.latestPrice,
        latestSoldAt: cardSplit.latestSoldAt,
      },
      baseline: { days: WINDOW_DAYS_BASELINE, n: cardBaselineN, medianPrice: baselineMedian },
      momentumRatio: ratio,
      projectedNextSale: (baselineMedian && ratio) ? clampProjection(baselineMedian, ratio) : null,
      attribution: {
        playerName: hint.playerName ?? null,
        setKey: hint.setName ?? null,
        cardYear: hint.cardYear ?? null,
        parallel: hint.parallel ?? null,
        playerFallbackRowsIncluded: 0,
        totalRowsScanned: cardTierRows.length,
      },
    };
  }

  // Player tier fallback — broader pool including player-fallback rows.
  // Requires (player, year, set) from the hint. Parallel filter is optional
  // but strongly recommended for accuracy.
  if (!hint.playerName || !hint.cardYear || !hint.setName) {
    return {
      ...empty,
      compsWindow: { ...empty.compsWindow, n: cardRecentN, medianPrice: median(cardSplit.recent), latestPrice: cardSplit.latestPrice, latestSoldAt: cardSplit.latestSoldAt },
      baseline: { ...empty.baseline, n: cardBaselineN, medianPrice: median(cardSplit.baseline) },
      attribution: { ...empty.attribution, totalRowsScanned: cardTierRows.length },
    };
  }

  const playerParams: QueryParam[] = [
    { name: "@pl", value: hint.playerName },
    { name: "@yr", value: hint.cardYear },
    { name: "@sk", value: hint.setName },
    { name: "@base", value: baselineCutoff },
  ];
  let playerWhere = "c.playerName = @pl AND c.cardYear = @yr AND c.setName = @sk AND c.soldAt >= @base";
  if (hint.parallel) {
    playerWhere += " AND c.parallel = @par";
    playerParams.push({ name: "@par", value: hint.parallel });
  }
  const playerTierRows = await queryComps(cont, playerWhere, playerParams);
  const playerSplit = splitWindow(playerTierRows, recentCutoff, baselineCutoff);
  const playerRecentN = playerSplit.recent.length;
  const playerBaselineN = playerSplit.baseline.length;

  if (playerRecentN === 0 && playerBaselineN === 0) {
    return {
      ...empty,
      attribution: {
        ...empty.attribution,
        totalRowsScanned: cardTierRows.length + playerTierRows.length,
      },
    };
  }

  const recentMedian = median(playerSplit.recent);
  const baselineMedian = median(playerSplit.baseline);
  const ratio = recentMedian && baselineMedian ? recentMedian / baselineMedian : null;
  return {
    tier: "player",
    cardId,
    hobbyiqCardId,
    compsWindow: {
      days: WINDOW_DAYS_RECENT,
      n: playerRecentN,
      medianPrice: recentMedian,
      latestPrice: playerSplit.latestPrice,
      latestSoldAt: playerSplit.latestSoldAt,
    },
    baseline: { days: WINDOW_DAYS_BASELINE, n: playerBaselineN, medianPrice: baselineMedian },
    momentumRatio: ratio,
    projectedNextSale: (baselineMedian && ratio) ? clampProjection(baselineMedian, ratio) : null,
    attribution: {
      playerName: hint.playerName,
      setKey: hint.setName,
      cardYear: hint.cardYear,
      parallel: hint.parallel ?? null,
      playerFallbackRowsIncluded: playerSplit.playerFallbackCount,
      totalRowsScanned: cardTierRows.length + playerTierRows.length,
    },
  };
}

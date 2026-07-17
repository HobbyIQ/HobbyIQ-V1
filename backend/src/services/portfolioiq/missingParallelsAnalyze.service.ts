// CF-MISSING-PARALLELS (Drew, 2026-07-17). Orchestration: for a user's
// holdings bucket (player, year, cardSet), pull every distinct
// (variant, number, cardId) from ch_daily_sales and return the ones
// the user doesn't own — sorted by median sale price DESC.

import { CosmosClient, type Container } from "@azure/cosmos";
import {
  computeMissingParallels,
  bucketKeyOf,
  type CorpusParallelRow,
  type MissingParallelsBundle,
} from "./missingParallelsCompute.service.js";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";

let sharedCHContainer: Container | null = null;

export function _setContainerForTesting(c: Container | null): void {
  sharedCHContainer = c;
}

async function getContainer(): Promise<Container> {
  if (sharedCHContainer) return sharedCHContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) throw new Error("COSMOS_CONNECTION_STRING not set — missingParallels cannot run");
  const client = new CosmosClient(cs);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  sharedCHContainer = db.container(process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales");
  return sharedCHContainer;
}

/** Query ch_daily_sales for every SKU in a specific bucket. Aggregates
 *  per-cardId (median price + count + latest image URL). */
async function readBucketRows(
  ch: Container, player: string, year: number, cardSet: string, windowDays = 90,
): Promise<CorpusParallelRow[]> {
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const iter = ch.items.query<{
    card_id: string; variant: string; number: string;
    price: number; image_url: string | null;
  }>({
    query: `SELECT c.card_id, c.variant, c.number, c.price, c.image_url
            FROM c
            WHERE c.player = @p
              AND c.year = @y
              AND c.card_set = @s
              AND c.sale_date >= @cutoff
              AND c.price > 0`,
    parameters: [
      { name: "@p", value: player },
      { name: "@y", value: year },
      { name: "@s", value: cardSet },
      { name: "@cutoff", value: cutoff },
    ],
  }, { maxItemCount: 5000 });

  const groups = new Map<string, {
    variant: string; number: string; prices: number[]; imageUrl: string | null;
  }>();
  while (iter.hasMoreResults()) {
    const page = await iter.fetchNext();
    if (!page.resources) continue;
    for (const row of page.resources) {
      if (!row.card_id) continue;
      let g = groups.get(row.card_id);
      if (!g) {
        g = { variant: row.variant ?? "", number: row.number ?? "",
              prices: [], imageUrl: row.image_url ?? null };
        groups.set(row.card_id, g);
      }
      g.prices.push(row.price);
    }
  }

  const rows: CorpusParallelRow[] = [];
  for (const [cardId, g] of groups.entries()) {
    if (g.prices.length === 0) continue;
    const median = medianOf(g.prices);
    rows.push({
      cardId,
      player, year, cardSet,
      variant: g.variant, number: g.number,
      recentSales: g.prices.length,
      medianPrice: median,
      imageUrl: g.imageUrl,
    });
  }
  return rows;
}

function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length / 2;
  return s.length % 2 === 1 ? s[Math.floor(mid)] : (s[mid - 1] + s[mid]) / 2;
}

/** Analyze missing parallels for a specific (player, year, cardSet)
 *  bucket. Caller supplies the user's full holdings list; we filter
 *  to those in the bucket to compute ownership. */
export async function analyzeMissingParallelsForBucket(
  holdings: PortfolioHolding[],
  player: string, year: number, cardSet: string,
): Promise<MissingParallelsBundle | null> {
  const ch = await getContainer();
  const ownedInBucket = holdings.filter(
    (h) => (h.playerName ?? "") === player
        && Number(h.cardYear) === year
        && ((h.setName ?? h.product ?? "") === cardSet),
  );
  if (ownedInBucket.length === 0) return null;

  const ownedCardIds = new Set<string>();
  for (const h of ownedInBucket) {
    // Best-effort resolve to CH cardId. Holdings may carry the resolver-
    // stamped cardsightCardId or a raw CH id. We accept both patterns.
    const cid = (h as unknown as { cardId?: string; cardsightCardId?: string }).cardId
      ?? (h as unknown as { cardsightCardId?: string }).cardsightCardId
      ?? null;
    if (cid) ownedCardIds.add(cid);
  }

  const ownedBuckets = new Set([bucketKeyOf(player, year, cardSet)]);
  const rows = await readBucketRows(ch, player, year, cardSet);
  const bundles = computeMissingParallels(ownedCardIds, ownedBuckets, rows);
  return bundles[0] ?? null;
}

/** Analyze missing parallels across ALL of a user's holdings, one
 *  bundle per distinct (player, year, cardSet). Cheap to run — one
 *  bucket per unique combo. */
export async function analyzeAllMissingParallels(
  holdings: PortfolioHolding[],
): Promise<MissingParallelsBundle[]> {
  const buckets = new Map<string, { player: string; year: number; cardSet: string }>();
  for (const h of holdings) {
    const player = h.playerName ?? "";
    const year = typeof h.cardYear === "number" ? h.cardYear : NaN;
    const cardSet = h.setName ?? h.product ?? "";
    if (!player || !Number.isFinite(year) || !cardSet) continue;
    buckets.set(bucketKeyOf(player, year, cardSet), { player, year, cardSet });
  }

  const results: MissingParallelsBundle[] = [];
  // Serial to avoid Cosmos RU spikes on portfolios with many buckets.
  for (const b of buckets.values()) {
    try {
      const bundle = await analyzeMissingParallelsForBucket(holdings, b.player, b.year, b.cardSet);
      if (bundle) results.push(bundle);
    } catch {
      /* best-effort per bucket */
    }
  }
  return results.sort((a, b) => a.player.localeCompare(b.player));
}

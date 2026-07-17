// CF-GUESTIMATE-PRICING (Drew, 2026-07-17). Data-fetch side of the
// no-comp compound-multiplier estimator. Pulls the two things the
// pure math (guestimatePricing.ts) needs from ch_daily_sales:
//
//   1. Family base Raw price — median of Raw non-parallel sales for a
//      (year, card_set_type) tuple over the last 90 days
//   2. Player tier — classified from the player's own raw sales median
//      across ALL cards they've ever appeared in
//
// Both cached in-process for 6h. Real-time freshness isn't important
// for these signals (families move on weekly timescales), and the
// query is cross-partition so we don't want to fire it per estimate.
//
// Never throws — returns null/"unknown" on any failure. Guestimate
// gracefully degrades: no family baseline → no guestimate.

import { CosmosClient, type Container } from "@azure/cosmos";
import type { PlayerTier } from "./guestimatePricing.js";

const CONTAINER_ID = process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales";
const DB_NAME = process.env.COSMOS_DATABASE ?? "hobbyiq";

const CACHE_TTL_MS = 6 * 3600 * 1000;   // 6h in-process
const WINDOW_DAYS = 90;
const MAX_SAMPLES = 500;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}
const familyBaselineCache = new Map<string, CacheEntry<number | null>>();
const playerTierCache = new Map<string, CacheEntry<PlayerTier>>();

let sharedContainer: Container | null = null;
function getContainer(): Container | null {
  if (sharedContainer) return sharedContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) return null;
  const client = new CosmosClient(cs);
  sharedContainer = client.database(DB_NAME).container(CONTAINER_ID);
  return sharedContainer;
}

/** Test seam. */
export function _setContainerForTesting(c: Container | null): void {
  sharedContainer = c;
  familyBaselineCache.clear();
  playerTierCache.clear();
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length / 2;
  return s.length % 2 === 1 ? s[Math.floor(mid)] : (s[mid - 1] + s[mid]) / 2;
}

/** Return the median Raw price for a card's base variant in a family.
 *  Family = (year + cardSetType). Returns null when < 5 samples in the
 *  window (guestimate won't fire on insufficient sample). */
export async function fetchFamilyBaseRawPrice(
  year: number,
  cardSetType: string,
): Promise<number | null> {
  const key = `${year}::${cardSetType.toLowerCase().trim()}`;
  const cached = familyBaselineCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const container = getContainer();
  if (!container) return null;
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

  try {
    // Query "base" raw sales — heuristic: variant IN ("Base", "", null)
    // OR variant equals "Refractor" (vanilla Refractor is the baseline
    // in the Bowman Chrome / Topps Chrome families).
    const iter = container.items.query<{ price: number }>({
      query: `SELECT c.price FROM c
              WHERE c.grader = 'Raw'
                AND c.year = @year
                AND c.card_set_type = @set
                AND c.sale_date >= @cutoff
                AND c.price > 0
                AND (
                  NOT IS_DEFINED(c.variant) OR
                  c.variant = '' OR
                  LOWER(c.variant) = 'base' OR
                  LOWER(c.variant) = 'refractor'
                )`,
      parameters: [
        { name: "@year", value: year },
        { name: "@set", value: cardSetType },
        { name: "@cutoff", value: cutoff },
      ],
    }, { maxItemCount: MAX_SAMPLES });

    const prices: number[] = [];
    while (iter.hasMoreResults() && prices.length < MAX_SAMPLES) {
      const page = await iter.fetchNext();
      if (!page.resources) continue;
      for (const row of page.resources) {
        if (Number.isFinite(row.price) && row.price > 0) prices.push(row.price);
      }
    }
    const base = prices.length >= 5 ? median(prices) : null;
    familyBaselineCache.set(key, { value: base, expiresAt: Date.now() + CACHE_TTL_MS });
    return base;
  } catch {
    return null;
  }
}

/** Classify a player into a tier based on their raw sales median
 *  across ALL cards. Uses simple price cuts:
 *    ≥ $500 → superstar
 *    ≥ $100 → star
 *    ≥  $20 → prospect
 *    ≥   $5 → common
 *    < $5 or no data → unknown */
export async function classifyPlayerTier(playerName: string): Promise<PlayerTier> {
  const key = playerName.toLowerCase().trim();
  if (!key) return "unknown";
  const cached = playerTierCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const container = getContainer();
  if (!container) return "unknown";
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

  try {
    const iter = container.items.query<{ price: number }>({
      query: `SELECT c.price FROM c
              WHERE c.grader = 'Raw'
                AND LOWER(c.player) = @p
                AND c.sale_date >= @cutoff
                AND c.price > 0`,
      parameters: [
        { name: "@p", value: key },
        { name: "@cutoff", value: cutoff },
      ],
    }, { maxItemCount: MAX_SAMPLES });

    const prices: number[] = [];
    while (iter.hasMoreResults() && prices.length < MAX_SAMPLES) {
      const page = await iter.fetchNext();
      if (!page.resources) continue;
      for (const row of page.resources) {
        if (Number.isFinite(row.price) && row.price > 0) prices.push(row.price);
      }
    }
    if (prices.length < 5) {
      playerTierCache.set(key, { value: "unknown", expiresAt: Date.now() + CACHE_TTL_MS });
      return "unknown";
    }
    const m = median(prices) ?? 0;
    const tier: PlayerTier =
      m >= 500 ? "superstar" :
      m >= 100 ? "star" :
      m >=  20 ? "prospect" :
      m >=   5 ? "common" :
                 "unknown";
    playerTierCache.set(key, { value: tier, expiresAt: Date.now() + CACHE_TTL_MS });
    return tier;
  } catch {
    return "unknown";
  }
}

// CF-NOTABLE-SALES-FEED (Drew, 2026-07-17). Read-only Cosmos query
// over ch_daily_sales for the "notable sales" social/marketing feed.
//
// Endpoint pulls the top-dollar sales that landed in the recent
// window (default 30 days, minimum price $100k, capped at 20 results).
// This is BOTH a discovery surface for the app (see what the big
// money is doing) AND a social-content feed we can auto-post to
// Twitter/IG.
//
// The reader NEVER mutates and NEVER throws — empty result on any
// container-side failure, so the endpoint stays green even during
// a Cosmos incident.

import type { Container } from "@azure/cosmos";
import { CosmosClient } from "@azure/cosmos";
import type { CHDailySaleRow } from "../../types/chDailySales.types.js";

const CONTAINER_ID = process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales";
const DB_NAME = process.env.COSMOS_DATABASE ?? "hobbyiq";

const DEFAULT_MIN_PRICE = 100_000;
const DEFAULT_DAYS = 30;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_DAYS = 365;

let sharedContainer: Container | null = null;

function getContainer(): Container | null {
  if (sharedContainer) return sharedContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) return null;
  const client = new CosmosClient(cs);
  sharedContainer = client.database(DB_NAME).container(CONTAINER_ID);
  return sharedContainer;
}

/** Test seam — inject a mock container. */
export function _setContainerForTesting(c: Container | null): void {
  sharedContainer = c;
}

/** One row of the notable-sales feed. Camel-cased subset of
 *  CHDailySaleRow plus a derived `sourceLabel`. */
export interface NotableSale {
  cardId: string;
  player: string;
  year: number;
  cardSet: string;
  variant: string;
  number: string;
  grade: string;
  grader: string;
  price: number;
  saleDate: string;
  imageUrl: string;
  listingUrl: string;
  /** Human-readable label derived from listingUrl domain. Null when the
   *  URL is empty / unparseable / from a domain we don't recognize. */
  sourceLabel:
    | "eBay"
    | "Goldin"
    | "Heritage"
    | "Fanatics Collect"
    | "Private"
    | null;
}

/** Options for the read. All optional with tight-bounded defaults. */
export interface NotableSalesOptions {
  minPrice?: number;
  days?: number;
  limit?: number;
}

export interface NotableSalesResult {
  count: number;
  sales: NotableSale[];
}

/** Read the top-dollar sales in the window. Never throws — container
 *  failures collapse to `{ count: 0, sales: [] }`. */
export async function readNotableSales(
  opts: NotableSalesOptions = {},
): Promise<NotableSalesResult> {
  const container = getContainer();
  if (!container) return { count: 0, sales: [] };

  const minPrice = clampNumber(opts.minPrice, DEFAULT_MIN_PRICE, 0, Number.POSITIVE_INFINITY);
  const days = clampInt(opts.days, DEFAULT_DAYS, 1, MAX_DAYS);
  const limit = clampInt(opts.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // CF-POKEMON-INGEST-DEFENSIVE (Drew, 2026-07-22). Explicit sports
  // whitelist so ch_daily_sales rows in newly-ingested groups (Pokemon,
  // Magic, Soccer, Hockey, TCG long-tail) don't silently appear on the
  // user-visible notable sales feed. Widen when we're ready to surface
  // Pokemon products through this feed; see memory
  // `pokemon-tcg-expansion-parked`.
  const query = `SELECT TOP ${limit} c.card_id, c.player, c.year, c.card_set, c.variant,
                        c.number, c.grade, c.grader, c.price, c.sale_date,
                        c.image_url, c.listing_url
                 FROM c
                 WHERE c.price >= @minPrice AND c.sale_date >= @sinceIso
                   AND c["group"] IN ('Baseball', 'Football', 'Basketball')
                 ORDER BY c.sale_date DESC`;

  try {
    const iter = container.items.query({
      query,
      parameters: [
        { name: "@minPrice", value: minPrice },
        { name: "@sinceIso", value: sinceIso },
      ],
    }, { maxItemCount: limit });

    const rows: CHDailySaleRow[] = [];
    while (iter.hasMoreResults()) {
      const page = await iter.fetchNext();
      if (page.resources) rows.push(...(page.resources as CHDailySaleRow[]));
      if (rows.length >= limit) break;
    }

    const sales = rows.slice(0, limit).map(toNotableSale);
    return { count: sales.length, sales };
  } catch {
    return { count: 0, sales: [] };
  }
}

function toNotableSale(row: CHDailySaleRow): NotableSale {
  return {
    cardId: row.card_id,
    player: row.player,
    year: row.year,
    cardSet: row.card_set,
    variant: row.variant,
    number: row.number,
    grade: row.grade,
    grader: row.grader,
    price: Number(row.price) || 0,
    saleDate: row.sale_date,
    imageUrl: row.image_url ?? "",
    listingUrl: row.listing_url ?? "",
    sourceLabel: deriveSourceLabel(row.listing_url ?? ""),
  };
}

/** Map a listing URL to a human-readable source label. Exposed for
 *  direct test coverage.
 *
 *   goldin.co → Goldin
 *   ha.com / sports.ha.com → Heritage
 *   fanaticscollect.com → Fanatics Collect
 *   ebay.com (any tld / subdomain) → eBay
 *   x.com / twitter.com → Private (social-media announced sales)
 *   else → null
 */
export function deriveSourceLabel(listingUrl: string): NotableSale["sourceLabel"] {
  if (!listingUrl || typeof listingUrl !== "string") return null;
  let host = "";
  try {
    const url = new URL(listingUrl.trim());
    host = url.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;

  // Strip a leading www. so www.ebay.com and ebay.com both match.
  const bare = host.replace(/^www\./, "");

  if (bare === "goldin.co" || bare.endsWith(".goldin.co")) return "Goldin";
  if (bare === "ha.com" || bare.endsWith(".ha.com")) return "Heritage";
  if (bare === "fanaticscollect.com" || bare.endsWith(".fanaticscollect.com")) return "Fanatics Collect";
  // ebay has many country tlds — treat any *.ebay.* as eBay.
  if (/(^|\.)ebay(\.[a-z]{2,3})+$/.test(bare)) return "eBay";
  if (bare === "x.com" || bare === "twitter.com") return "Private";
  return null;
}

function clampInt(raw: unknown, fallback: number, lo: number, hi: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return Math.min(hi, Math.max(lo, i));
}

function clampNumber(raw: unknown, fallback: number, lo: number, hi: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Constants exposed for pinning tests. */
export const _NOTABLE_SALES_DEFAULTS = {
  minPrice: DEFAULT_MIN_PRICE,
  days: DEFAULT_DAYS,
  limit: DEFAULT_LIMIT,
  maxLimit: MAX_LIMIT,
  maxDays: MAX_DAYS,
} as const;

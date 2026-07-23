// CF-CARDSIGHT-RESTORE (2026-07-13): slim Cardsight client — minimal
// surface for the VendorSource plugin (search + pricing only).
//
// The pre-cutover client (removed 2026-06-27 at 08c24f3) was 1080 lines
// covering catalog search, autocomplete, images, pricing, grade taxonomy,
// budget tracking, retries, cache warming, and more. This slim rebuild
// covers ONLY what the multi-source resolver needs: given a structured
// card query, find the top-matching catalog entry and its pricing.
//
// Everything else (autocomplete UI, image proxying, grade-id resolver,
// budget tracking) stays retired — those callers were already migrated
// to the catalogSource seam and none of them route back through this
// module.
//
// API: https://api.cardsight.ai/v1
// Auth: X-API-Key header from CARDSIGHT_API_KEY env var
// When key is absent: every function returns empty/null. Silent no-op —
// the vendor plugin can register safely even without a key configured.

import { cacheWrap } from "../shared/cache.service.js";

function cacheKey(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts].join("|");
}

const BASE_URL = "https://api.cardsight.ai/v1";
const DEFAULT_TIMEOUT_MS = 8_000;

// CF-CARDSIGHT-CACHE (Drew, 2026-07-14): Cardsight catalog is essentially
// static — cards don't get renamed and their parallels tree changes on
// vendor releases, not intraday. Cache aggressively so the Verify Card
// sheet's edit-loop (which calls dry-run-suggest on every field edit)
// stops paying the ~350ms cold-catalog+detail-fetch cost per keystroke.
//
// TTLs chosen for the different volatility profiles:
//   - searchCatalog: 6h  — new SKU could appear intraday; stale-safe window
//   - getCardDetail: 24h — parallels tree even more static
//
// Both use skipCacheWhen to avoid locking in transient empty responses
// (same pattern as CH's cardhedge.client — vendor blips shouldn't
// blackhole a query for the whole TTL window).
const SEARCH_CACHE_TTL_SEC = 6 * 3600;
const DETAIL_CACHE_TTL_SEC = 24 * 3600;

function apiKey(): string | null {
  const key = process.env.CARDSIGHT_API_KEY;
  return key && key.trim() ? key.trim() : null;
}

export function isCardsightConfigured(): boolean {
  return apiKey() !== null;
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CardsightCatalogHit {
  id: string;
  name: string;
  number: string;
  releaseName: string;
  setName: string;
  year: number;
  player?: string;
}

export interface CardsightParallel {
  id: string;
  name: string;
  numberedTo?: number | null;
}

export interface CardsightCardDetail {
  id: string;
  name: string;
  number: string;
  releaseName: string;
  setName: string;
  year: number;
  parallels: CardsightParallel[];
  notFound?: boolean;
}

// CF-CARDSIGHT-COMPLETE-COMPS (Drew, 2026-07-13, PR #416): expanded record
// shape so downstream engine + iOS see the full Cardsight sale metadata
// (title, listing_type, image_url, url). Cardsight's /v1/pricing already
// emits these fields; the narrow prior shape was silently dropping them.
export interface CardsightSaleRecord {
  price: number;
  date: string | null;
  title?: string | null;
  source?: string | null;
  listing_type?: string | null;
  url?: string | null;
  image_url?: string | null;
  parallel_id?: string | null;
  parallel_name?: string | null;
}

// CF-CS-STRUCTURED-BRIDGE (Drew, 2026-07-15): shapes returned by
// GET /v1/catalog/cards. Same purpose as CH's card-search — structured
// filter search that bypasses the AI/fuzzy matcher when we already have
// identity fields (player + cardNumber + year).
export interface CardsightCardSummaryParallel {
  id: string;                     // UUID
  name: string;                   // "Blue Refractor" etc.
  numberedTo?: number | null;
}

export interface CardsightCardSummary {
  id: string;                     // parent card UUID
  name: string;                   // player name (mostly)
  number?: string | null;
  setId?: string | null;
  setName?: string | null;
  releaseId?: string | null;
  releaseName?: string | null;
  releaseYear?: string | null;
  description?: string | null;
  isParallelOnly?: boolean;
  attributes?: string[];
  parallels?: CardsightCardSummaryParallel[];
}

export interface CardsightPaginatedCardsResponse {
  cards: CardsightCardSummary[];
  total_count: number;
  skip: number;
  take: number;
}

// CF-CS-PRICING-BACKSTOP (Drew, 2026-07-15): shape returned by
// GET /v1/pricing/search. Free-text title fuzzy search over marketplace
// listings — surfaces sales even when neither CH nor CS catalog resolves
// the SKU. Includes unmatched listings (matched_card omitted).
export interface CardsightPricingSearchRecord {
  title: string | null;
  price: number;
  date: string | null;
  source: string;                    // e.g. "ebay"
  listing_type: "auction" | "fixed" | null;
  url: string | null;
  image_url: string | null;
  parallel_id: string | null;
  parallel_name: string | null;
  matched_card?: unknown;            // canonical card when matched — kept opaque
  grade?: unknown;                   // grade context for graded listings
}

export interface CardsightPricingSearchResponse {
  query?: unknown;
  results: CardsightPricingSearchRecord[];
  meta?: unknown;
}

export interface CardsightPricingResponse {
  card?: {
    card_id?: string;
    name?: string;
    number?: string;
    set?: { name?: string; year?: string; release?: string };
  };
  raw: { count: number; records: CardsightSaleRecord[] };
  graded: Array<{
    company_name: string;
    grades: Array<{
      grade_value: string;
      count: number;
      records: CardsightSaleRecord[];
    }>;
  }>;
  meta: { total_records: number; last_sale_date: string | null };
  notFound?: boolean;
}

// ─── Search ────────────────────────────────────────────────────────────────

/**
 * Free-text catalog search. Returns top matches or empty on miss / no key.
 * `year` filter improves precision when the query is otherwise noisy.
 */
export async function searchCatalog(
  query: string,
  opts: { year?: number; take?: number } = {},
): Promise<CardsightCatalogHit[]> {
  const key = apiKey();
  if (!key) return [];
  const q = query.trim();
  if (!q) return [];
  const take = opts.take ?? 10;
  const year = opts.year ?? "";

  return cacheWrap<CardsightCatalogHit[]>(
    cacheKey("cs:catalog-search", q, String(take), String(year)),
    async () => _searchCatalogRaw(q, take, opts.year),
    {
      freshTtlSeconds: SEARCH_CACHE_TTL_SEC,
      // Don't lock in a transient empty response — same reasoning as
      // CH's cardhedge.client search cache (CF-CH-SEARCH-NO-CACHE-EMPTY).
      skipCacheWhen: (result) => !result || result.length === 0,
    },
  );
}

async function _searchCatalogRaw(
  q: string,
  take: number,
  year: number | undefined,
): Promise<CardsightCatalogHit[]> {
  const key = apiKey();
  if (!key) return [];
  const params = new URLSearchParams({
    q,
    type: "card",
    segment: "baseball",
    take: String(take),
  });
  if (year !== undefined) params.set("year", String(year));

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const res = await fetch(`${BASE_URL}/catalog/search?${params}`, {
      headers: { "X-API-Key": key, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      console.warn(JSON.stringify({
        event: "cardsight_search_http_error",
        source: "cardsightSlim.client",
        status: res.status,
        query: q,
      }));
      return [];
    }
    const body = await res.json();
    return Array.isArray(body?.results) ? body.results as CardsightCatalogHit[] : [];
  } catch (err) {
    console.warn(JSON.stringify({
      event: "cardsight_search_error",
      source: "cardsightSlim.client",
      query: q,
      error: (err as Error)?.message ?? String(err),
    }));
    return [];
  }
}

// ─── Card detail (needed for parallelId lookup) ────────────────────────────

/**
 * Fetch a card's full catalog metadata including its parallel list. Used
 * by the vendor plugin to match a query's parallel string against the
 * catalog card's parallels, then filter pricing by that parallelId.
 * Aggregated pricing without parallelId mixes every variant's sales and
 * produces misleading medians (base + Refractor + colors together).
 */
export async function getCardDetail(cardId: string): Promise<CardsightCardDetail | null> {
  const key = apiKey();
  if (!key || !cardId) return null;
  return cacheWrap<CardsightCardDetail | null>(
    cacheKey("cs:card-detail", cardId),
    async () => _getCardDetailRaw(cardId),
    {
      freshTtlSeconds: DETAIL_CACHE_TTL_SEC,
      // Don't cache a 404/null — a card that briefly failed to fetch
      // (network blip) shouldn't be blackholed for 24h.
      skipCacheWhen: (result) => result === null,
    },
  );
}

async function _getCardDetailRaw(cardId: string): Promise<CardsightCardDetail | null> {
  const key = apiKey();
  if (!key) return null;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const res = await fetch(`${BASE_URL}/catalog/cards/${encodeURIComponent(cardId)}`, {
      headers: { "X-API-Key": key, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return (await res.json()) as CardsightCardDetail;
  } catch {
    return null;
  }
}

// ─── Pricing ───────────────────────────────────────────────────────────────

/**
 * Pricing for a resolved card_id. Returns notFound=true on miss or empty
 * shape when no key. Never throws — errors → notFound.
 *
 * When `parallelId` is set, Cardsight filters comps to that specific
 * parallel — crucial for accurate pricing. Without it, the response
 * pools every variant of the card together (base + all colors) and the
 * median is misleading for graded/high-end parallels.
 *
 * Fallback semantic: when parallel_id is supplied but Cardsight returns
 * 0 comps (empirical quirk noted in the original client 2026-05-27),
 * caller should retry without the filter to get the unified pool as a
 * last-resort signal.
 */
export async function getPricing(
  cardId: string,
  opts: { parallelId?: string } = {},
): Promise<CardsightPricingResponse> {
  const empty: CardsightPricingResponse = {
    raw: { count: 0, records: [] },
    graded: [],
    meta: { total_records: 0, last_sale_date: null },
    notFound: true,
  };
  const key = apiKey();
  if (!key) return empty;
  if (!cardId) return empty;

  const params = new URLSearchParams();
  if (opts.parallelId) params.set("parallel_id", opts.parallelId);
  const qs = params.toString();
  const url = `${BASE_URL}/pricing/${encodeURIComponent(cardId)}${qs ? `?${qs}` : ""}`;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "X-API-Key": key, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (res.status === 404) return empty;
    if (!res.ok) {
      console.warn(JSON.stringify({
        event: "cardsight_pricing_http_error",
        source: "cardsightSlim.client",
        status: res.status,
        cardId,
      }));
      return empty;
    }
    return (await res.json()) as CardsightPricingResponse;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "cardsight_pricing_error",
      source: "cardsightSlim.client",
      cardId,
      error: (err as Error)?.message ?? String(err),
    }));
    return empty;
  }
}

// ─── Pricing search backstop (CF-CS-PRICING-BACKSTOP) ─────────────────────

/** 6h cache — same as searchCatalog. Backstop queries are user-driven and
 *  the underlying listings pool changes hourly-daily, so 6h fresh-window is
 *  the right balance between hit rate and staleness. */
const PRICING_SEARCH_CACHE_TTL_SEC = 6 * 3600;

/**
 * Free-text fuzzy search over marketplace listing titles for HISTORICAL
 * pricing. Ultimate backstop for cards neither CH nor CS catalog resolves —
 * returns raw seller-title matches. Includes UNMATCHED listings (matched_card
 * omitted) which is exactly what we need for CH-catalog-gap SKUs.
 *
 * IMPORTANT: default listing_type is "both" but for FMV purposes callers
 * should pass "auction" only — fixed listings are ASKING prices (never
 * necessarily a completed sale) and would inflate the median.
 */
export async function searchPricingByTitle(
  q: string,
  opts: {
    period?: "7d" | "14d" | "3m" | "1y" | "all";
    listingType?: "auction" | "fixed" | "both";
    limit?: number;
    // CF-PERSIST-VENDOR-LOOKUPS (Drew, 2026-07-23, issue #722):
    // caller-supplied identity hint. When provided, the results are
    // shipped to persistVendorSalesInBackground so sold_comps grows
    // as a side-effect of the query. Feature-flagged: gated by
    // PERSIST_VENDOR_LOOKUPS_ENABLED env var (default OFF).
    persistIdentity?: {
      playerName?: string | null;
      cardYear?: number | null;
      sport?: string | null;
    };
  } = {},
): Promise<CardsightPricingSearchRecord[]> {
  const key = apiKey();
  if (!key) return [];
  const query = q.trim();
  if (query.length < 3 || query.length > 300) return [];
  const period = opts.period ?? "3m";
  const listingType = opts.listingType ?? "auction";  // completed sales only by default
  const limit = Math.min(500, Math.max(1, opts.limit ?? 50));

  const results = await cacheWrap<CardsightPricingSearchRecord[]>(
    cacheKey("cs:pricing-search", query, period, listingType, String(limit)),
    async () => _searchPricingByTitleRaw(query, period, listingType, limit),
    {
      freshTtlSeconds: PRICING_SEARCH_CACHE_TTL_SEC,
      // Don't cache empty responses — if the pool momentarily missed, next
      // call should retry (same pattern as searchCatalog).
      skipCacheWhen: (result) => !result || result.length === 0,
    },
  );

  // CF-PERSIST-VENDOR-LOOKUPS: fire-and-forget persistence. If the
  // caller provided an identity hint, ship the parsed results to
  // sold_comps in the background. Never blocks or fails the caller.
  if (opts.persistIdentity && results.length > 0) {
    // Lazy import so the client module doesn't force-load persistence
    // wiring at load time.
    import("../portfolioiq/persistVendorSalesToPool.service.js")
      .then(({ persistVendorSalesInBackground }) => {
        persistVendorSalesInBackground(
          "cardsight",
          results.map((r) => ({
            title: r.title,
            price: r.price,
            soldAt: r.date,
            url: r.url,
          })),
          opts.persistIdentity!,
        );
      })
      .catch(() => { /* import failure = silent no-op */ });
  }

  return results;
}

async function _searchPricingByTitleRaw(
  q: string,
  period: string,
  listingType: string,
  limit: number,
): Promise<CardsightPricingSearchRecord[]> {
  const key = apiKey();
  if (!key) return [];
  const params = new URLSearchParams({
    q,
    period,
    listing_type: listingType,
    limit: String(limit),
  });
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const res = await fetch(`${BASE_URL}/pricing/search?${params}`, {
      headers: { "X-API-Key": key, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      console.warn(JSON.stringify({
        event: "cardsight_pricing_search_http_error",
        source: "cardsightSlim.client",
        status: res.status,
        query: q,
      }));
      return [];
    }
    const body = (await res.json()) as CardsightPricingSearchResponse;
    return Array.isArray(body?.results) ? body.results : [];
  } catch (err) {
    console.warn(JSON.stringify({
      event: "cardsight_pricing_search_error",
      source: "cardsightSlim.client",
      query: q,
      error: (err as Error)?.message ?? String(err),
    }));
    return [];
  }
}

// ─── Structured catalog lookup (CF-CS-STRUCTURED-BRIDGE) ──────────────────

/** 6h cache — catalog cards don't churn intraday; same TTL as searchCatalog. */
const STRUCTURED_CATALOG_CACHE_TTL_SEC = 6 * 3600;

/**
 * Structured lookup against CS's /v1/catalog/cards. Same purpose as CH's
 * card-search: bypass the fuzzy matcher when we already have (player,
 * cardNumber, year). Returns the CardSummary array — each entry includes
 * the parent card UUID + inline parallels[] tree so callers can pick the
 * exact variant without a second detail call.
 *
 * Params: only the ones we actually use. Full spec supports more filters
 * (releaseId, setId, manufacturer, field=KEY:VALUE, sort) — add as needed.
 */
export async function getCatalogCards(opts: {
  name?: string;
  number?: string;
  releaseName?: string;
  year?: number | string;
  setName?: string;
  attributeShortName?: string;
  take?: number;
  skip?: number;
}): Promise<CardsightCardSummary[]> {
  const key = apiKey();
  if (!key) return [];
  const take = Math.min(100, Math.max(1, opts.take ?? 30));
  const skip = Math.max(0, opts.skip ?? 0);

  const params = new URLSearchParams({
    take: String(take),
    skip: String(skip),
  });
  if (opts.name) params.set("name", opts.name);
  if (opts.number) params.set("number", opts.number);
  if (opts.releaseName) params.set("releaseName", opts.releaseName);
  if (opts.year !== undefined && opts.year !== null && String(opts.year).length > 0) {
    params.set("year", String(opts.year));
  }
  if (opts.setName) params.set("setName", opts.setName);
  if (opts.attributeShortName) params.set("attributeShortName", opts.attributeShortName);

  const cacheK = cacheKey(
    "cs:catalog-cards",
    opts.name ?? "",
    opts.number ?? "",
    opts.releaseName ?? "",
    opts.year != null ? String(opts.year) : "",
    opts.setName ?? "",
    opts.attributeShortName ?? "",
    String(take),
    String(skip),
  );

  return cacheWrap<CardsightCardSummary[]>(
    cacheK,
    async () => _getCatalogCardsRaw(params.toString()),
    {
      freshTtlSeconds: STRUCTURED_CATALOG_CACHE_TTL_SEC,
      // Don't lock in a transient empty response — same reasoning as
      // searchCatalog. Structured misses on a KNOWN cardNumber usually
      // mean the card exists but our filter combo was wrong, not that
      // the SKU is missing forever.
      skipCacheWhen: (result) => !result || result.length === 0,
    },
  );
}

async function _getCatalogCardsRaw(qs: string): Promise<CardsightCardSummary[]> {
  const key = apiKey();
  if (!key) return [];
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const res = await fetch(`${BASE_URL}/catalog/cards?${qs}`, {
      headers: { "X-API-Key": key, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      console.warn(JSON.stringify({
        event: "cardsight_catalog_cards_http_error",
        source: "cardsightSlim.client",
        status: res.status,
        qs,
      }));
      return [];
    }
    const body = (await res.json()) as CardsightPaginatedCardsResponse;
    return Array.isArray(body?.cards) ? body.cards : [];
  } catch (err) {
    console.warn(JSON.stringify({
      event: "cardsight_catalog_cards_error",
      source: "cardsightSlim.client",
      qs,
      error: (err as Error)?.message ?? String(err),
    }));
    return [];
  }
}

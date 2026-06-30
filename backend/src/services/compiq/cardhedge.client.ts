// Card Hedge AI client — primary sold-data source for CompIQ search.
//
// Mirrors compiq-functions/shared/cardhedge.py. We never call Card Hedge live
// in the MCP prediction pipeline (cached blob only); this client is for the
// free-text /api/compiq/search and /api/compiq/price routes where the iOS
// user types an ad-hoc query that may not be cached.
//
// API:   https://api.cardhedger.com/v1
// Auth:  X-API-Key: $CARD_HEDGE_API_KEY
// Prices come back as strings in DOLLARS (e.g. "850" or "45.99"). Coerce to
// float — do NOT divide by 100.

import { cacheWrap } from "../shared/cache.service.js";

const BASE_URL = "https://api.cardhedger.com/v1";
const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_IDENTITY_CONFIDENCE = 0.8;

// Card Hedge own TTLs per the published spec:
//   identity match : 7 days
//   comps          : 12 hours
const MATCH_TTL_SEC = 6 * 3600;        // 6h — shorter than CH's 7d so titles refresh same-day
const COMPS_TTL_SEC = 12 * 3600;
const SEARCH_TTL_SEC = 6 * 3600;
const PRICES_BY_CARD_TTL_SEC = 4 * 3600;  // 4h — daily series, primary trust signal


function cacheKey(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts.map((p) => p.toLowerCase().replace(/\s+/g, " ").trim())].join(":");
}

function headers(): Record<string, string> | null {
  const key = process.env.CARD_HEDGE_API_KEY;
  if (!key) return null;
  return {
    "X-API-Key": key,
    "Content-Type": "application/json",
  };
}

function toFloat(value: unknown): number {
  const n = typeof value === "string" ? parseFloat(value) : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export interface CardHedgeCard {
  card_id: string;
  player?: string;
  set?: string;
  year?: number | string;
  number?: string;
  variant?: string;
  title?: string;
  name?: string;
  /** Front-facing card image (CardHedge bubble.io CDN URL), normalized from
   *  the several image fields CH may return. Undefined when none present. */
  image?: string;
}

/**
 * CardHedge card-search hits carry the front image under one of several
 * keys (`image`, `image_url`, `front_image`, `front_image_url`) or an
 * `images[]` array of strings / `{ url }`. Return the first http(s) URL.
 */
function pickCardImage(raw: any): string | undefined {
  const isUrl = (u: unknown): u is string =>
    typeof u === "string" && /^https?:\/\//i.test(u);
  const candidates: unknown[] = [
    raw?.front_image_url,
    raw?.image_url,
    raw?.front_image,
    raw?.image,
  ];
  if (Array.isArray(raw?.images)) {
    for (const it of raw.images) {
      if (typeof it === "string") candidates.push(it);
      else if (it && typeof it === "object") candidates.push((it as any).url);
    }
  }
  candidates.push(raw?.back_image_url);
  for (const c of candidates) {
    if (isUrl(c)) return c;
  }
  return undefined;
}

export interface CardHedgeSale {
  price: number;
  date: string | null;
  grade: string;
  source: string;
  sale_type: string | null;
  title: string | null;
  url: string | null;
}

/**
 * CF-CH-STRUCTURED-SEARCH-FILTERS (2026-06-28): optional structured filter
 * fields the CardHedge `/cards/card-search` endpoint supports natively.
 * Sending these alongside the free-text `search` lets CH's tokenizer narrow
 * by player / set / rookie status instead of chewing through everything as
 * one free-text blob. Before this CF, queries like "drake baldwin 2025
 * bowman chrome image variation" returned 0 candidates because CH couldn't
 * confidently match the variant within a too-noisy search string.
 *
 * All fields are optional. When omitted, behavior is byte-identical to the
 * pre-CF call shape — the existing callers (pricing path, sibling fetch,
 * image lookup) keep their semantics.
 */
export interface CardSearchFilters {
  /** Filter by player name (e.g. "Drake Baldwin"). */
  player?: string | null;
  /** Filter by set name (e.g. "2025 Bowman Chrome Baseball"). */
  set?: string | null;
  /** Filter by rookie status (e.g. "Rookie" — CH's enum value). */
  rookie?: string | null;
}

/** POST /cards/card-search — free-text card lookup (Baseball). */
export async function searchCards(
  query: string,
  limit = 10,
  filters?: CardSearchFilters,
): Promise<CardHedgeCard[]> {
  const h = headers();
  if (!h) {
    console.warn("[cardhedge.client] CARD_HEDGE_API_KEY missing");
    return [];
  }
  // Filter values folded into the cache key so the same `query` with
  // different structured filters doesn't collide on a stale cached payload.
  const filterKey = filters
    ? [filters.player ?? "", filters.set ?? "", filters.rookie ?? ""].join("|")
    : "";
  return cacheWrap(
    cacheKey("ch:search", query, String(limit), filterKey),
    async () => _searchCards(query, limit, h, filters),
    SEARCH_TTL_SEC,
  );
}

async function _searchCards(
  query: string,
  limit: number,
  h: Record<string, string>,
  filters?: CardSearchFilters,
): Promise<CardHedgeCard[]> {
  try {
    const body: Record<string, unknown> = {
      search: query,
      category: "Baseball",
      page: 1,
      page_size: Math.max(1, Math.min(limit, 50)),
    };
    // CF-CH-STRUCTURED-SEARCH-FILTERS: only emit each filter key when the
    // value is non-empty. CH treats omitted fields as "no filter" — sending
    // an empty string would (per the docs) be a "match empty string" filter.
    if (filters?.player && filters.player.length > 0) body.player = filters.player;
    if (filters?.set && filters.set.length > 0) body.set = filters.set;
    if (filters?.rookie && filters.rookie.length > 0) body.rookie = filters.rookie;

    const res = await fetch(`${BASE_URL}/cards/card-search`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[cardhedge.client] search HTTP ${res.status} for "${query}"`);
      return [];
    }
    const respBody: any = await res.json();
    const rawCards: any[] = Array.isArray(respBody?.cards) ? respBody.cards : [];
    // Normalize the image field onto each card so downstream consumers
    // (RoutedCard → search candidates → priced-card hero) get a stable
    // `image` regardless of which image key CardHedge populated.
    const cards: CardHedgeCard[] = rawCards.map((c) => ({
      ...c,
      image: pickCardImage(c),
    }));
    return cards.slice(0, limit);
  } catch (err: any) {
    console.warn(`[cardhedge.client] search threw for "${query}":`, err?.message ?? err);
    return [];
  }
}

/**
 * CF-CH-MATCH-CARD-BOOST (2026-06-28): fetch full card details for a
 * card_id. Used when `identifyCard` returns a card_id that ISN'T in the
 * search result set (i.e., AI matched a variant CH's token search buried
 * beyond our 100-result window). The returned CardHedgeCard has the
 * same shape as `searchCards` hits, so the dispatcher can adapt it via
 * the existing `chCardToRoutedCard` → `routedCardToIdentity` path.
 *
 * Returns null on any HTTP error, network failure, or shape mismatch —
 * the dispatcher gracefully degrades to the search-only path.
 */
export async function getCardDetailsById(cardId: string): Promise<CardHedgeCard | null> {
  const h = headers();
  if (!h || !cardId) return null;
  return cacheWrap(
    cacheKey("ch:card-details", cardId),
    async () => _getCardDetailsById(cardId, h),
    SEARCH_TTL_SEC,
  );
}

async function _getCardDetailsById(cardId: string, h: Record<string, string>): Promise<CardHedgeCard | null> {
  try {
    const res = await fetch(`${BASE_URL}/cards/card-details`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ card_id: cardId }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[cardhedge.client] card-details HTTP ${res.status} for "${cardId}"`);
      return null;
    }
    const respBody: any = await res.json();
    // CF-CH-CARD-DETAILS-SHAPE-FIX (2026-06-28): /v1/cards/card-details
    // returns `{pages, count, cards: [...]}` — the same shape as
    // /cards/card-search, NOT the top-level card I'd guessed from the docs
    // example. Pick the first element of `cards` whose card_id matches.
    // Fallbacks: nested `card`, then top-level (defensive coverage).
    let raw: any = null;
    if (Array.isArray(respBody?.cards) && respBody.cards.length > 0) {
      raw = respBody.cards.find((c: any) => c?.card_id === cardId) ?? respBody.cards[0];
    } else if (respBody?.card) {
      raw = respBody.card;
    } else if (respBody?.card_id) {
      raw = respBody;
    }
    if (!raw || typeof raw.card_id !== "string") return null;
    return { ...raw, image: pickCardImage(raw) } as CardHedgeCard;
  } catch (err: any) {
    console.warn(`[cardhedge.client] card-details threw for "${cardId}":`, err?.message ?? err);
    return null;
  }
}

/**
 * CF-CH-FMV-CROSS-VALIDATE (2026-06-28): CardHedge's two reference-FMV
 * shapes. `card-fmv` returns the rich index-adjusted FMV (with
 * confidence_grade A/B/C/D, freshness_days, English explanation);
 * `price-estimate` returns the lean direct estimate (price + range +
 * confidence + method only).
 *
 * Both endpoints require `card_id` + `grade` ("Raw", "PSA 10", etc.).
 * Returns null on any HTTP/network/shape failure — caller must treat
 * a null response as "no reference signal" and degrade silently.
 */
export interface CardHedgeFmv {
  price: number;
  price_low: number | null;
  price_high: number | null;
  confidence: number | null;
  method: string | null;
  freshness_days: number | null;
  support_grades: number | null;
  grade_label: string | null;
  provider: string | null;
  grade_value: number | null;
  as_of_date?: string | null;
  confidence_grade?: string | null;
  raw_price?: number | null;
  price_explanation?: string | null;
  index_pct_change?: number | null;
  [k: string]: unknown;
}

export interface CardHedgePriceEstimate {
  price: number;
  price_low: number | null;
  price_high: number | null;
  confidence: number | null;
  method: string | null;
  freshness_days: number | null;
  support_grades: number | null;
  grade_label: string | null;
  provider: string | null;
  grade_value: number | null;
}

const FMV_TTL_SEC = 12 * 3600;  // 12h — matches CH's comps cadence; FMV is daily.

export async function getCardFmv(cardId: string, grade: string): Promise<CardHedgeFmv | null> {
  const h = headers();
  if (!h || !cardId || !grade) return null;
  return cacheWrap(
    cacheKey("ch:card-fmv", cardId, grade),
    async () => _postFmvShape<CardHedgeFmv>("/cards/card-fmv", { card_id: cardId, grade }, h),
    FMV_TTL_SEC,
  );
}

export async function getPriceEstimate(cardId: string, grade: string): Promise<CardHedgePriceEstimate | null> {
  const h = headers();
  if (!h || !cardId || !grade) return null;
  return cacheWrap(
    cacheKey("ch:price-estimate", cardId, grade),
    async () => _postFmvShape<CardHedgePriceEstimate>("/cards/price-estimate", { card_id: cardId, grade }, h),
    FMV_TTL_SEC,
  );
}

async function _postFmvShape<T extends { price: number }>(
  path: string,
  body: Record<string, unknown>,
  h: Record<string, string>,
): Promise<T | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[cardhedge.client] ${path} HTTP ${res.status} for card_id=${body.card_id}`);
      return null;
    }
    const respBody: any = await res.json();
    if (!respBody || typeof respBody.price !== "number" || !Number.isFinite(respBody.price)) return null;
    return respBody as T;
  } catch (err: any) {
    console.warn(`[cardhedge.client] ${path} threw for card_id=${body.card_id}:`, err?.message ?? err);
    return null;
  }
}

/**
 * CF-CH-TREND-INGEST (2026-06-28): CardHedge's per-player sales
 * trend signals. Three endpoints, three product surfaces:
 *
 *   sales-stats-by-player → weekly buckets (count, avg_sale, total) per
 *                            player. The week-over-week trajectory is the
 *                            player-level price-class momentum signal.
 *   total-sales-by-player → 30d total sale count per player. Volume /
 *                            attention proxy (engaged-fan-tier of cascade).
 *   top-movers            → weekly top gainers across the catalog.
 *
 * Both player-keyed endpoints require a `players` array (NOT singular
 * `player` — they're batch shapes). category defaults to "Baseball" to
 * stay aligned with the rest of the engine.
 */
export interface SalesStatsBucket {
  start: string;
  end: string;
  count: number;
  total_amount: number;
  average_sale: number;
  partial: boolean;
}

export interface SalesStatsByPlayerResult {
  player: string;
  buckets: SalesStatsBucket[];
}

export interface SalesStatsByPlayerResponse {
  interval: "day" | "week" | "month";
  periods: number;
  results: SalesStatsByPlayerResult[];
}

export interface TotalSalesByPlayerResult {
  player: string;
  total_sales: number;
  search_time_ms?: number;
}

export interface TotalSalesByPlayerResponse {
  results: TotalSalesByPlayerResult[];
  days: number;
}

export interface TopMoverCard {
  card_id: string;
  description: string;
  player: string;
  set: string;
  number: string;
  variant: string;
  image?: string;
  category: string;
  set_type?: string;
  rookie: boolean;
  gain: number;
  "7 Day Sales"?: number;
  "30 Day Sales"?: number;
  prices?: Array<{ grade: string; price: string }>;
}

const TREND_TTL_SEC = 12 * 3600;        // 12h — CH refreshes once daily.
const TOP_MOVERS_TTL_SEC = 6 * 3600;    // 6h — surfaces in app, refresh more often.

export async function getSalesStatsByPlayer(
  players: string[],
  interval: "day" | "week" | "month" = "week",
  category: string = "Baseball",
): Promise<SalesStatsByPlayerResponse | null> {
  const h = headers();
  if (!h || !players?.length) return null;
  return cacheWrap(
    cacheKey("ch:sales-stats", category, interval, players.slice().sort().join(",")),
    async () =>
      _postTyped<SalesStatsByPlayerResponse>(
        "/cards/sales-stats-by-player",
        { players, interval, category },
        h,
      ),
    TREND_TTL_SEC,
  );
}

export async function getTotalSalesByPlayer(
  players: string[],
  category: string = "Baseball",
): Promise<TotalSalesByPlayerResponse | null> {
  const h = headers();
  if (!h || !players?.length) return null;
  return cacheWrap(
    cacheKey("ch:total-sales", category, players.slice().sort().join(",")),
    async () =>
      _postTyped<TotalSalesByPlayerResponse>(
        "/cards/total-sales-by-player",
        { players, category },
        h,
      ),
    TREND_TTL_SEC,
  );
}

export interface GetTopMoversOptions {
  /** Number of cards to return. CH default = 20, max ≈ 100. */
  count?: number;
  /** Optional category filter — e.g. "Baseball", "Basketball", "Pokemon".
   *  Omit for all categories combined. */
  category?: string;
}

/**
 * CF-CH-TOP-MOVERS-PARAMS (2026-06-30): enhanced to accept count + category
 * query params. CH's /v1/cards/top-movers supports both; we previously
 * passed neither, locking to defaults (count=20, all categories). Now
 * callers can request "20 baseball cards" cleanly. CH caches the
 * response server-side for 1 hour, and our own cacheWrap layers another
 * 6h on top (TTL keyed by params).
 */
export async function getTopMovers(
  opts: GetTopMoversOptions = {},
): Promise<TopMoverCard[] | null> {
  const h = headers();
  if (!h) return null;
  const count = Number.isFinite(opts.count) && opts.count! > 0 ? Math.floor(opts.count!) : 20;
  const category = typeof opts.category === "string" && opts.category.trim().length > 0
    ? opts.category.trim()
    : null;
  const cacheKeySuffix = `${count}|${category ?? "all"}`;
  return cacheWrap(
    cacheKey("ch:top-movers", cacheKeySuffix),
    async () => {
      try {
        const params = new URLSearchParams();
        params.set("count", String(count));
        if (category) params.set("category", category);
        const res = await fetch(`${BASE_URL}/cards/top-movers?${params.toString()}`, {
          method: "GET",
          headers: h,
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
        if (!res.ok) {
          console.warn(`[cardhedge.client] top-movers HTTP ${res.status}`);
          return null;
        }
        const respBody: any = await res.json();
        const cards: any[] = Array.isArray(respBody?.cards) ? respBody.cards : [];
        return cards as TopMoverCard[];
      } catch (err: any) {
        console.warn("[cardhedge.client] top-movers threw:", err?.message ?? err);
        return null;
      }
    },
    TOP_MOVERS_TTL_SEC,
  );
}

async function _postTyped<T>(
  path: string,
  body: Record<string, unknown>,
  h: Record<string, string>,
): Promise<T | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[cardhedge.client] ${path} HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err: any) {
    console.warn(`[cardhedge.client] ${path} threw:`, err?.message ?? err);
    return null;
  }
}

/** POST /cards/card-match — AI text match. Returns null when confidence < 0.80. */
export async function identifyCard(query: string): Promise<{ card_id: string; confidence: number; [k: string]: any } | null> {
  const h = headers();
  if (!h || !query.trim()) return null;
  // Cache wrapper — JSON-encode null as "" sentinel so misses are still cached and we don't hammer CH on bad queries.
  const raw = await cacheWrap(
    cacheKey("ch:match", query),
    async () => {
      const body = await _identifyCard(query, h);
      return body ? JSON.stringify(body) : "";
    },
    MATCH_TTL_SEC,
  );
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function _identifyCard(query: string, h: Record<string, string>): Promise<{ card_id: string; confidence: number; [k: string]: any } | null> {
  try {
    const res = await fetch(`${BASE_URL}/cards/card-match`, {
      method: "POST",
      headers: h,
      // No category hint — CH's AI ignores it anyway (case-15 probe: with
      // hint=Baseball the AI still returned a Basketball Jordan match at
      // confidence 0.96, which the engine then mis-priced as a 1991 UD
      // Baseball novelty). We instead read `match.category` from the
      // response and let computeEstimate's unsupported-sport guard reject
      // non-baseball results cleanly. The fallback path (_searchCards)
      // remains hard-locked to category="Baseball", so even if identifyCard
      // returns null, no non-baseball card can leak through.
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    // CH /cards/card-match returns { match: {card_id, confidence, …} | null,
    // candidates_evaluated, search_query_used }. The actual card payload is
    // nested under `match`; `match: null` means CH's AI declined to commit
    // to a candidate (low confidence or no candidates). Reading top-level
    // body.confidence/body.card_id (the previous bug) made every call return
    // null, silently disabling the AI-match fast path in production.
    const match = body?.match;
    if (!match || typeof match !== "object") return null;
    const confidence = Number(match.confidence ?? 0);
    if (!Number.isFinite(confidence) || confidence < MIN_IDENTITY_CONFIDENCE) return null;
    if (!match.card_id) return null;
    // CH calls the human-readable label `description`; downstream code
    // (cardMatchesTokens → candidateText) reads `title`. Mirror the field
    // so token-checks see the AI's full descriptor.
    return { ...match, title: match.title ?? match.description ?? null };
  } catch (err: any) {
    console.warn("[cardhedge.client] identify threw:", err?.message ?? err);
    return null;
  }
}

/** POST /cards/comps — sold comps with raw prices in DOLLARS. */
export async function getCardSales(
  cardId: string,
  grade: string = "Raw",
  limit: number = 20,
): Promise<CardHedgeSale[]> {
  const h = headers();
  if (!h) return [];
  return cacheWrap(
    cacheKey("ch:comps", cardId, grade, String(limit)),
    async () => _getCardSales(cardId, grade, limit, h),
    COMPS_TTL_SEC,
  );
}

async function _getCardSales(
  cardId: string,
  grade: string,
  limit: number,
  h: Record<string, string>,
): Promise<CardHedgeSale[]> {
  try {
    const res = await fetch(`${BASE_URL}/cards/comps`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        card_id: cardId,
        count: limit,
        grade,
        include_raw_prices: true,
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[cardhedge.client] comps HTTP ${res.status} for card_id=${cardId}`);
      return [];
    }
    const body: any = await res.json();
    const raw: any[] = Array.isArray(body?.raw_prices) ? body.raw_prices : [];
    return raw
      .filter((s) => s?.price != null)
      .map((s) => ({
        price: toFloat(s.price),
        date: s.sale_date ?? null,
        grade: s.grade ?? grade,
        source: s.price_source ?? "card_hedge",
        sale_type: s.sale_type ?? null,
        title: s.title ?? null,
        url: s.sale_url ?? null,
      }))
      .filter((s) => s.price > 0);
  } catch (err: any) {
    console.warn(`[cardhedge.client] comps threw for card_id=${cardId}:`, err?.message ?? err);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// prices-by-card (daily series) + trust-guard
//
// Discovered during CF-CARDHEDGE-VALUE-AUDIT (2026-06-25): Card Hedge's
// /v1/cards/comps endpoint returns a generic recent-sales bucket (up to ~102
// unrelated TCG records, all stamped today's date) when the matched card_id
// has zero genuine sales bound to it. The "blob" passes superficial sanity
// checks (the per-sale card_id ECHOES the queried id) but the underlying
// titles are Pokemon/Yu-Gi-Oh/One Piece cards from a global recent-sales feed.
//
// /v1/cards/prices-by-card is the canonical truth signal: it returns an empty
// daily series for card_ids without genuine pricing data, where /comps would
// blob. The trust-guard below uses prices-by-card as the primary gate and
// title-cohesion on (player surname, expected year) as a defense-in-depth
// secondary check.
// ─────────────────────────────────────────────────────────────────────────────

/** Single daily-closing-price row from /v1/cards/prices-by-card. */
export interface CardHedgeDailyPrice {
  closing_date: string;  // ISO date (YYYY-MM-DD)
  price: number;
}

/** POST /cards/prices-by-card — daily closing-price series for a card_id. */
export async function getPricesByCard(
  cardId: string,
  grade: string = "Raw",
  days: number = 30,
): Promise<CardHedgeDailyPrice[]> {
  const h = headers();
  if (!h || !cardId) return [];
  return cacheWrap(
    cacheKey("ch:prices-by-card", cardId, grade, String(days)),
    () => _getPricesByCard(cardId, grade, days, h),
    PRICES_BY_CARD_TTL_SEC,
  );
}

async function _getPricesByCard(
  cardId: string,
  grade: string,
  days: number,
  h: Record<string, string>,
): Promise<CardHedgeDailyPrice[]> {
  try {
    const res = await fetch(`${BASE_URL}/cards/prices-by-card`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ card_id: cardId, grade, days }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[cardhedge.client] prices-by-card HTTP ${res.status} for card_id=${cardId}`);
      return [];
    }
    const body: any = await res.json();
    const arr: any[] = Array.isArray(body?.prices) ? body.prices : [];
    return arr
      .map((p) => ({
        closing_date: typeof p?.closing_date === "string" ? p.closing_date.slice(0, 10) : "",
        price: toFloat(p?.price),
      }))
      .filter((p) => p.closing_date && p.price > 0)
      .sort((a, b) => a.closing_date.localeCompare(b.closing_date));
  } catch (err: any) {
    console.warn(`[cardhedge.client] prices-by-card threw for card_id=${cardId}:`, err?.message ?? err);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Trust-guard
// ─────────────────────────────────────────────────────────────────────────────

/** Identity tokens supplied by the caller to grade CH's title cohesion. */
export interface CardHedgeIdentity {
  /** Lowercase surname (or single-token name) expected to appear in real titles. */
  playerSurname: string;
  /** Year string (4 digits) expected to appear in real titles. */
  expectedYear: string;
}

export type CHTrustReason =
  | "prices_by_card_honest"   // primary trust signal — daily series non-empty
  | "title_cohesion_strong"   // secondary trust — ≥80% titles cohere on player + year
  | "no_real_data"            // CH has no genuine data for this card_id
  | "blob_signature";         // looks like the global recent-sales fallback bucket

export interface CardHedgeTrustedComps {
  trusted: boolean;
  reason: CHTrustReason;
  comps: CardHedgeSale[];
  /** Convenience aggregates (only populated when trusted). */
  median: number | null;
  count: number;
  newestDate: string | null;
  /** Days-of-daily-series from prices-by-card (the primary trust signal). */
  pricesByCardLength: number;
}

const BLOB_REJECT_THRESHOLD = 0.1;   // <10% titles match either token → blob
const TRUST_ACCEPT_THRESHOLD = 0.8;  // ≥80% titles match BOTH tokens → trust

function median(prices: number[]): number | null {
  if (!prices.length) return null;
  const s = prices.slice().sort((a, b) => a - b);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/**
 * Pure trust-check on the raw inputs. Exported for unit-test access; the
 * production path runs through getTrustedComps which orchestrates fetch +
 * trust together so no caller can ever bypass the guard.
 *
 * Decision order:
 *   1. prices-by-card has ≥1 daily point → trust ("prices_by_card_honest").
 *      This is the canonical signal. CH's prices-by-card endpoint stays
 *      honest when getCardSales blobs; if it has data, getCardSales' data
 *      for the same card_id is also real.
 *   2. sales empty → trust:false, reason "no_real_data".
 *   3. Title cohesion on (playerSurname, expectedYear):
 *      blob   — both hit-rates <10%   → reject  ("blob_signature")
 *      strong — both hit-rates ≥80%   → trust   ("title_cohesion_strong")
 *      uncertain — anything else      → DEFAULT REJECT ("blob_signature")
 *                 Better a clean miss → fall through to Cardsight floor than
 *                 to ship a half-blob.
 *
 * NOTE: For step 3 to be even reached, prices-by-card MUST be empty. That
 * means the secondary signal exists as defense-in-depth — if for some
 * reason the daily-series was empty but real sales exist (unlikely given
 * today's audit), title cohesion can still rescue trust. The conservative
 * default-reject biases away from false-trust.
 */
export function checkCHTrust(
  sales: CardHedgeSale[],
  pricesByCardLength: number,
  identity: CardHedgeIdentity,
): { trusted: boolean; reason: CHTrustReason } {
  if (pricesByCardLength >= 1) {
    return { trusted: true, reason: "prices_by_card_honest" };
  }
  if (sales.length === 0) {
    return { trusted: false, reason: "no_real_data" };
  }
  const surname = identity.playerSurname.toLowerCase().trim();
  const year = identity.expectedYear.trim();
  const playerHits = sales.filter((s) => (s.title ?? "").toLowerCase().includes(surname)).length;
  const yearHits = sales.filter((s) => (s.title ?? "").includes(year)).length;
  const playerHitRate = playerHits / sales.length;
  const yearHitRate = yearHits / sales.length;

  if (playerHitRate < BLOB_REJECT_THRESHOLD && yearHitRate < BLOB_REJECT_THRESHOLD) {
    return { trusted: false, reason: "blob_signature" };
  }
  if (playerHitRate >= TRUST_ACCEPT_THRESHOLD && yearHitRate >= TRUST_ACCEPT_THRESHOLD) {
    return { trusted: true, reason: "title_cohesion_strong" };
  }
  return { trusted: false, reason: "blob_signature" };
}

/**
 * PRODUCTION COMP-FETCH ENTRY POINT.
 *
 * Returns trust-guarded comps for a Card Hedge card_id. Callers MUST use this
 * method (not raw getCardSales) to ensure the blob fallback bucket never
 * reaches the pricing engine.
 *
 * Flow:
 *   1. prices-by-card(cardId, days=30). If empty → return no_real_data;
 *      getCardSales is NOT called (saves one HTTP, avoids the blob entirely).
 *   2. getCardSales(cardId, grade).
 *   3. checkCHTrust(sales, pricesByCardLength, identity).
 *      Trusted:  { trusted:true, comps, median, count, newestDate }.
 *      Rejected: { trusted:false, comps:[] } — caller falls through to
 *                Cardsight or other floor.
 *
 * Latency: 1-2 HTTP requests against api.cardhedger.com, both cached (4h
 * prices-by-card, 12h getCardSales). Misses → 2 sequential HTTPS calls.
 */
export async function getTrustedComps(
  cardId: string,
  identity: CardHedgeIdentity,
  grade: string = "Raw",
): Promise<CardHedgeTrustedComps> {
  const empty = (reason: CHTrustReason): CardHedgeTrustedComps => ({
    trusted: false,
    reason,
    comps: [],
    median: null,
    count: 0,
    newestDate: null,
    pricesByCardLength: 0,
  });

  if (!cardId) return empty("no_real_data");

  const series = await getPricesByCard(cardId, grade, 30);
  if (series.length === 0) {
    return empty("no_real_data");
  }

  const sales = await getCardSales(cardId, grade, 50);
  const verdict = checkCHTrust(sales, series.length, identity);

  if (!verdict.trusted) {
    return {
      trusted: false,
      reason: verdict.reason,
      comps: [],
      median: null,
      count: 0,
      newestDate: null,
      pricesByCardLength: series.length,
    };
  }

  const prices = sales.map((s) => s.price).filter((p) => p > 0);
  const dates = sales.map((s) => s.date).filter((d): d is string => !!d).sort();

  return {
    trusted: true,
    reason: verdict.reason,
    comps: sales,
    median: median(prices),
    count: sales.length,
    newestDate: dates.length ? dates[dates.length - 1] : null,
    pricesByCardLength: series.length,
  };
}

/**
 * Required-token validation. Card Hedge's AI match scores on title similarity
 * and frequently returns near-matches that drop critical qualifiers (auto,
 * print run, color). We extract the "must-have" tokens from the user's query
 * and reject any candidate whose variant/title/set doesn't carry them.
 */
const COLOR_WORDS = [
  "blue", "red", "gold", "orange", "green", "yellow", "black", "white",
  "purple", "pink", "aqua", "teal", "silver", "bronze",
];
// Qualifier words that precede a base color and create a DIFFERENT variant.
// e.g. "Sky Blue" is not "Blue"; "Royal Blue" is not "Blue".
const COLOR_QUALIFIERS = [
  "sky", "royal", "navy", "light", "dark", "ice", "electric", "neon",
  "baby", "midnight", "powder", "ocean", "deep", "hot", "rose", "ruby",
  "emerald", "forest", "lime", "mint", "lemon", "canary", "amber",
  "rainbow", "mojo", "snake", "tiger", "shimmer", "speckle", "cracked",
];
const PARALLEL_WORDS = [
  "wave", "refractor", "prizm", "mosaic", "select", "optic", "donruss",
  "atomic", "shimmer", "sparkle", "x-fractor", "xfractor", "ice", "lava",
  "neon", "scope", "disco", "cracked", "hyper", "speckle", "pulsar",
  "draft", "rayfractor", "raywave",
];

export interface ColorToken {
  base: string;                 // e.g. "blue"
  qualifier: string | null;     // e.g. "sky" when query says "sky blue"; null when bare
}

export interface RequiredTokens {
  isAuto: boolean;
  serial: string | null;        // e.g. "150" from "/150"
  colors: ColorToken[];
  parallels: string[];
}

export function extractRequiredTokens(query: string): RequiredTokens {
  const q = query.toLowerCase();
  const isAuto = /\b(auto|autograph|signed|signature)\b/.test(q);
  const serialMatch = q.match(/\/\s*(\d{1,4})\b/);
  const serial = serialMatch ? serialMatch[1] : null;
  const colors: ColorToken[] = [];
  for (const c of COLOR_WORDS) {
    const re = new RegExp(`(?:\\b(${COLOR_QUALIFIERS.join("|")})\\s+)?\\b${c}\\b`, "i");
    const m = q.match(re);
    if (m) colors.push({ base: c, qualifier: m[1]?.toLowerCase() ?? null });
  }
  const parallels = PARALLEL_WORDS.filter((p) => new RegExp(`\\b${p.replace(/[-]/g, "\\-")}\\b`, "i").test(q));
  return { isAuto, serial, colors, parallels };
}

function candidateText(c: CardHedgeCard): string {
  return [c.title, c.name, c.set, c.variant, c.number].filter(Boolean).join(" ").toLowerCase();
}

// Card-number prefixes Card Hedge uses for autograph SKUs. The autograph-ness
// is encoded in the card number (e.g. "CPA-CBO" = Chrome Prospect Autograph),
// NOT in the variant or set text. Without this list a "Blue Auto" query
// rejects the CPA-CBO Blue Refractor card because its text contains no
// literal "auto" / "autograph" token.
const AUTO_NUMBER_PREFIXES = [
  "CPA",   // Chrome Prospect Autograph (Bowman Draft Chrome / Bowman Chrome)
  "BCP-A", // Older Bowman Chrome Prospect Auto
  "BCPA",  // Bowman Chrome Prospect Autograph
  "BPA",   // Bowman Prospect Autograph
  "PA",    // Prospect Autograph
  "CRA",   // Chrome Rookie Autograph (Topps Chrome)
  "RA",    // Rookie Autograph
  "BCRA",  // Bowman Chrome Rookie Autograph
  "BSA",   // Bowman Sterling Autograph
  "BCA",   // Bowman's Best Chrome Autograph / Bowman Chrome Auto
  "TCA",   // Topps Chrome Autograph
  "USA",   // Update Star Autograph
  "AU",    // Generic autograph
  "BBA",   // Bowman's Best Autograph
  "BSPA",  // Bowman Sterling Prospect Autograph
  "FA",    // Future Autograph (Topps Update / etc.)
  "ROA",   // Rookie of the Year Autograph (Donruss / etc.)
];
const AUTO_PREFIX_RE = new RegExp(
  `(?:^|\\b)(?:${AUTO_NUMBER_PREFIXES.map((p) => p.toLowerCase()).join("|")})[- ]`,
  "i"
);

function hasAutoSignal(c: CardHedgeCard, text: string): boolean {
  if (/(auto|autograph|signed|signature)/.test(text)) return true;
  const num = (c.number ?? "").toString().toLowerCase();
  if (num && AUTO_PREFIX_RE.test(num)) return true;
  return false;
}

/** True when the card's text mentions every required token. */
export function cardMatchesTokens(c: CardHedgeCard, tokens: RequiredTokens): boolean {
  const text = candidateText(c);
  if (tokens.isAuto && !hasAutoSignal(c, text)) return false;
  if (tokens.serial && !new RegExp(`/\\s*${tokens.serial}\\b`).test(text)) return false;
  if (!matchesColors(text, tokens.colors)) return false;
  for (const par of tokens.parallels) {
    if (!new RegExp(`\\b${par.replace(/[-]/g, "\\-")}\\b`).test(text)) return false;
  }
  return true;
}

/**
 * Color matching with qualifier discipline:
 *   - Query "blue" must NOT match a card whose color is "sky blue", "royal
 *     blue", "navy blue", etc. — those are distinct variants.
 *   - Query "sky blue" must match only cards explicitly labelled "sky blue".
 *   - Query with no color is unconstrained.
 */
function matchesColors(text: string, colors: ColorToken[]): boolean {
  for (const { base, qualifier } of colors) {
    if (qualifier) {
      // Require the exact qualified phrase.
      if (!new RegExp(`\\b${qualifier}\\s+${base}\\b`).test(text)) return false;
    } else {
      // Require the base color AND ensure it is not preceded by a qualifier
      // that would make it a different variant.
      const qualifierRe = new RegExp(`\\b(${COLOR_QUALIFIERS.join("|")})\\s+${base}\\b`);
      if (qualifierRe.test(text)) return false;
      if (!new RegExp(`\\b${base}\\b`).test(text)) return false;
    }
  }
  return true;
}

/**
 * Convenience: free-text query → best-match card → recent comps.
 *
 * Resolution order:
 *   1. identifyCard() — AI match ≥0.80 confidence
 *   2. token validation — if matched card drops a required qualifier (auto,
 *      /serial, color, parallel keyword), reject and try searchCards()
 *   3. searchCards() — pick the first candidate that passes token validation
 *   4. simplifyQuery() retry — last-ditch noise-stripped search
 *
 * Returns { card: null, sales: [] } if nothing matches the user's intent.
 */
/** Reports which required tokens a candidate card is missing. */
export function tokenMismatches(c: CardHedgeCard, tokens: RequiredTokens): string[] {
  const text = candidateText(c);
  const out: string[] = [];
  if (tokens.isAuto && !hasAutoSignal(c, text)) out.push("autograph");
  if (tokens.serial && !new RegExp(`/\\s*${tokens.serial}\\b`).test(text)) out.push(`/${tokens.serial}`);
  for (const { base, qualifier } of tokens.colors) {
    const phrase = qualifier ? `${qualifier} ${base}` : base;
    if (qualifier) {
      if (!new RegExp(`\\b${qualifier}\\s+${base}\\b`).test(text)) out.push(phrase);
    } else {
      const qre = new RegExp(`\\b(${COLOR_QUALIFIERS.join("|")})\\s+${base}\\b`);
      if (qre.test(text) || !new RegExp(`\\b${base}\\b`).test(text)) out.push(phrase);
    }
  }
  for (const par of tokens.parallels) {
    if (!new RegExp(`\\b${par.replace(/[-]/g, "\\-")}\\b`).test(text)) out.push(par);
  }
  return out;
}

export async function findCompsByQuery(
  query: string,
  opts: { grade?: string; limit?: number } = {}
): Promise<{
  card: CardHedgeCard | null;
  sales: CardHedgeSale[];
  variantWarning: string[];
  /**
   * Sport category as identified by Card Hedge's AI match (e.g. "Baseball",
   * "Basketball", "Football"). Populated when identifyCard returned a
   * high-confidence match that carried a `category` field; null otherwise
   * (no AI match, low confidence, or category field absent). Consumed by
   * compiqEstimate.service.ts's unsupported-sport guard so non-baseball
   * cards short-circuit to source="unsupported_sport" instead of being
   * silently mis-priced.
   */
  aiCategory: string | null;
}> {
  const grade = opts.grade ?? "Raw";
  const limit = opts.limit ?? 20;
  if (!query?.trim()) return { card: null, sales: [], variantWarning: [], aiCategory: null };

  // Strip grade tokens (PSA 10, BGS 9.5, SGC 10, "Gem Mint", bare "Raw") from
  // the query before any Card Hedge call. CH card_ids are grade-agnostic —
  // grading lives on individual sales under a SKU, never in the SKU title —
  // so leaving "PSA 10" in the query lowers identifyCard confidence below
  // MIN_IDENTITY_CONFIDENCE (0.80) and skews searchCards ranking. On
  // strict-variant queries (auto + color + parallel) this drops every
  // candidate that would pass cardMatchesTokens, falling through to a wrong-
  // variant fallback and emitting a spurious "autograph" variantWarning that
  // trips the variant-mismatch guard in compiqEstimate.service.ts. Grade is
  // already passed separately via opts.grade where it correctly filters
  // sales by grade tier in getCardSales(). See issue #6 for full diagnosis.
  const skuQuery = stripGradingTokens(query);

  const tokens = extractRequiredTokens(query);

  // Try high-confidence AI match first.
  const matched = await identifyCard(skuQuery);
  const aiCandidate: CardHedgeCard | null = matched
    ? {
        card_id: matched.card_id,
        player: matched.player,
        set: matched.set,
        year: matched.year,
        number: matched.number,
        variant: matched.variant,
        title: matched.title,
      }
    : null;
  // Sport category from the AI match payload — surfaced to the caller so
  // computeEstimate can short-circuit non-baseball queries. CH returns
  // strings like "Baseball", "Basketball", "Football". null when no
  // high-confidence match or when the category field is missing.
  const aiCategory: string | null =
    matched && typeof matched.category === "string" && matched.category.trim()
      ? matched.category.trim()
      : null;

  // 1. Prefer an exact-token match from the AI result.
  let card: CardHedgeCard | null = null;
  if (aiCandidate && cardMatchesTokens(aiCandidate, tokens)) {
    card = aiCandidate;
  }

  // 2. Fall back to searchCards filtered by exact tokens.
  let searchHits: CardHedgeCard[] = [];
  if (!card) {
    searchHits = await searchCards(skuQuery, 25);
    card = searchHits.find((h) => cardMatchesTokens(h, tokens)) ?? null;
  }

  // 3. Try simplified query for exact tokens.
  if (!card) {
    const simplified = simplifyQuery(skuQuery);
    if (simplified && simplified !== skuQuery) {
      const hits = await searchCards(simplified, 25);
      searchHits = [...searchHits, ...hits];
      card = hits.find((h) => cardMatchesTokens(h, tokens)) ?? null;
    }
  }

  // 3b. Autograph-prospect taxonomy retry. Card Hedge stores Bowman/Topps
  // Chrome autograph prospects under bare "Bowman Chrome Baseball" /
  // "Topps Chrome Baseball" set names with the autograph-ness encoded only
  // in a CPA-/BCPA-/CRA- number prefix. CompIQ requests routinely arrive
  // using the collector-convention "Bowman Chrome Prospects Autograph"
  // phrasing, which CH's lexical search never ranks the CPA-* cards into
  // the top results for — so the search above returns only the non-auto
  // BCP-* Prospects rainbow, none of which pass cardMatchesTokens(isAuto).
  // Stripping the literal phrase "Prospect(s) Autograph|Auto" lets CH
  // surface the actual auto SKUs; hasAutoSignal() / AUTO_NUMBER_PREFIXES
  // already accepts them via the CPA- number prefix.
  if (!card && tokens.isAuto) {
    const stripped = stripAutoSetPhrases(skuQuery);
    if (stripped && stripped !== skuQuery) {
      console.log(
        `[cardhedge.client] auto-phrase retry: "${skuQuery}" -> "${stripped}" (tokens.isAuto=true, prior attempts found no auto candidate)`,
      );
      const hits = await searchCards(stripped, 25);
      searchHits = [...searchHits, ...hits];
      card = hits.find((h) => cardMatchesTokens(h, tokens)) ?? null;
    }
  }

  // 4. No exact match — fall back to the best candidate and emit a warning.
  let variantWarning: string[] = [];
  if (!card) {
    const fallback = aiCandidate ?? searchHits[0] ?? null;
    if (fallback) {
      variantWarning = tokenMismatches(fallback, tokens);
      console.warn(
        `[cardhedge.client] No exact match for "${skuQuery}" (original: "${query}") — using fallback variant="${fallback.variant}" (missing: ${variantWarning.join(", ")})`
      );
      card = fallback;
    }
  }

  if (!card?.card_id) return { card: null, sales: [], variantWarning: [], aiCategory };
  const allSales = await getCardSales(card.card_id, grade, limit);

  // Post-filter sales by required tokens (only when we had an exact card match;
  // for warning-fallback we keep all sales so the user sees the comp set).
  // For autograph cards we DON'T filter sales by the "auto" keyword — the
  // matched card_id is already an autograph SKU (e.g. CPA-CBO), and seller
  // titles routinely omit the word "auto" ("2024 Bowman Draft Chrome Caleb
  // Bonemer Blue Refractor /150"). Filtering on "auto" would zero out the
  // comp pool for the card we just confirmed.
  let sales = allSales;
  if (variantWarning.length === 0) {
    const filteredSales = allSales.filter((s) => {
      const text = (s.title ?? "").toLowerCase();
      if (!text) return true;
      if (tokens.serial && !new RegExp(`/\\s*${tokens.serial}\\b`).test(text)) return false;
      if (!matchesColors(text, tokens.colors)) return false;
      for (const par of tokens.parallels) {
        if (!new RegExp(`\\b${par.replace(/[-]/g, "\\-")}\\b`).test(text)) return false;
      }
      return true;
    });
    sales = filteredSales.length >= 1 ? filteredSales : allSales;
  }

  return { card, sales, variantWarning, aiCategory };
}

/**
 * Strip noise tokens that trip up Card Hedge's AI match ("rc", "rookie",
 * "card", "#nnn", duplicate spaces). Keeps year + player + set tokens.
 */
function simplifyQuery(q: string): string {
  return q
    .replace(/#\s*\d+/g, "")
    .replace(/\b(rookie|rc|card|psa|bgs|sgc|gem mint|mint|prospects?|autograph)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip the collector-convention phrase "Prospect(s) Autograph|Auto" from a
 * query so Card Hedge's lexical search can surface the actual autograph SKUs.
 *
 * CH stores Bowman/Topps Chrome autograph prospects under bare set names
 * ("2024 Bowman Chrome Baseball", "2024 Topps Chrome Baseball") with the
 * autograph-ness encoded only in a CPA-/BCPA-/CRA- number prefix. Queries
 * built from collector convention ("2024 Bowman Chrome Prospects Autograph")
 * never lexically match CH's set names, so its search ranks the non-auto
 * BCP-* Prospects rainbow above the auto cards and the auto SKUs fall off
 * the top page. Removing the phrase lets the CPA-* cards rank correctly;
 * hasAutoSignal() / AUTO_NUMBER_PREFIXES already accepts them downstream.
 *
 * Exported for unit testing.
 */
export function stripAutoSetPhrases(q: string): string {
  return q
    .replace(/\bprospects?\s+(?:autograph|auto)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip grading tokens (PSA 10, BGS 9.5, SGC 10, "Gem Mint", bare "Raw")
 * before sending a query to Card Hedge's AI card-match or card-search.
 *
 * Grading lives on individual sales under a card_id, never on the SKU
 * itself — leaving these tokens in the query lowers identifyCard
 * confidence below MIN_IDENTITY_CONFIDENCE (0.80) and skews searchCards
 * ranking, which on strict-variant queries (auto + color + refractor)
 * falls through to a wrong-variant fallback and emits a spurious
 * variant-mismatch warning. The numeric tail of the grade ("10", "9.5")
 * MUST be stripped together with the company keyword — leaving the bare
 * digit behind still confuses CH search ranking.
 *
 * Companion to `simplifyQuery` (which strips broader noise like "rookie",
 * "rc", "card", "#nnn" for the step-3 retry path). Both are kept separate
 * so each has a single responsibility; `stripGradingTokens` runs once at
 * the top of `findCompsByQuery` so every CH call downstream is already
 * grade-free.
 *
 * Exported for unit testing.
 */
export function stripGradingTokens(q: string): string {
  return q
    .replace(/\b(psa|bgs|sgc|cgc|hga|beckett)\s*\d+(?:\.\d)?\b/gi, " ")
    .replace(/\bgem\s*mint\b/gi, " ")
    .replace(/\braw\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Cross-parallel sibling comp fetcher.
//
// When CH has thin/stale comps for the user's target card, pull comps from
// OTHER parallels of the same player+year+set so fallback pricing logic can
// derive the target price via parallel multipliers (e.g. Blue
// Wave /150 → infer from Aqua /125 + Orange /25 + Refractor base).
// ---------------------------------------------------------------------------

export interface SiblingComp {
  card_id: string;
  variant: string;
  number: string;
  title: string;
  price: number;
  soldDate: string | null;
}

/**
 * Fetch sold comps for every sibling parallel of (player, year, set) that
 * isn't `excludeCardId`. Sibling card_ids are discovered via /cards/card-search.
 * Each returned comp's title is prefixed with the sibling's variant so the
 * downstream parallel-tier parser can classify it correctly.
 *
 * Returns [] on any error — caller falls back to whatever it already had.
 */
export async function fetchSiblingParallelComps(opts: {
  playerName: string;
  year?: number | string | null;
  set?: string | null;
  excludeCardId?: string | null;
  grade?: string;
  perSiblingLimit?: number;
  maxSiblings?: number;
}): Promise<SiblingComp[]> {
  const {
    playerName,
    year,
    set: setName,
    excludeCardId,
    grade = "Raw",
    perSiblingLimit = 6,
    maxSiblings = 12,
  } = opts;
  if (!playerName?.trim()) return [];

  // Build a catalog query strong enough to filter to the right product line.
  const queryParts = [playerName.trim(), year != null ? String(year) : "", setName ?? ""].filter(
    Boolean
  );
  const query = queryParts.join(" ").trim();
  const catalog = await searchCards(query, 25);
  if (catalog.length === 0) return [];

  // Filter siblings: same player + (best-effort) same set, exclude the target.
  const playerSlug = playerName.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  const setSlug = (setName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const siblings = catalog
    .filter((c) => c.card_id && c.card_id !== excludeCardId)
    .filter((c) => {
      const p = (c.player ?? "").toLowerCase();
      return playerSlug ? p.includes(playerSlug.split(/\s+/).slice(-1)[0]) : true;
    })
    .filter((c) => {
      if (!setSlug) return true;
      const cs = (c.set ?? "").toLowerCase();
      // require at least one set token overlap (year-bowman-chrome etc.)
      const tokens = setSlug.split(/\s+/).filter((t) => t.length >= 4);
      if (tokens.length === 0) return true;
      return tokens.some((t) => cs.includes(t));
    })
    .slice(0, maxSiblings);

  if (siblings.length === 0) return [];

  // Fetch comps for each sibling in parallel (CH client already caches 12hr).
  const results = await Promise.all(
    siblings.map(async (s) => {
      try {
        const sales = await getCardSales(s.card_id, grade, perSiblingLimit);
        return sales
          .filter((sale) => sale.price > 0)
          .map<SiblingComp>((sale) => ({
            card_id: s.card_id,
            variant: s.variant ?? "Base",
            number: s.number ?? "",
            // Synthesize a title that includes the sibling's variant so
            // downstream parallel-tier parsing can classify it.
            title:
              sale.title ??
              `${playerName} ${year ?? ""} ${setName ?? ""} ${s.variant ?? ""} ${s.number ?? ""}`.trim(),
            price: sale.price,
            soldDate: sale.date,
          }));
      } catch (err: any) {
        console.warn(
          `[cardhedge.client] sibling comps failed for card_id=${s.card_id}:`,
          err?.message ?? err
        );
        return [];
      }
    })
  );

  const merged = results.flat();
  console.log(
    `[cardhedge.client] sibling-parallel comps: ${siblings.length} siblings → ${merged.length} comps for player="${playerName}" year=${year} set="${setName ?? ""}"`
  );
  return merged;
}

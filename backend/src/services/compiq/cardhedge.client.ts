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

/**
 * CF-CH-COST-TRACKING (2026-07-06, Drew): every outbound CH request
 * emits a `ch_call` telemetry event with path + status + took_ms +
 * ok. Aggregated in App Insights this gives us a per-day CH cost
 * dashboard (queries in docs/observability/ch-cost-tracking.md).
 *
 * Wraps the native fetch — behavior is byte-identical to the direct
 * call. Errors are logged AND rethrown so callers see the same
 * failure surface as before.
 */
async function chFetch(url: string, init: RequestInit): Promise<Response> {
  const t0 = Date.now();
  // Extract the path (everything after v1/) for stable grouping.
  const pathMatch = url.match(/https:\/\/api\.cardhedger\.com\/v1(\/[^?]*)(\?|$)/);
  const path = pathMatch ? pathMatch[1] : url;
  try {
    const res = await fetch(url, init);
    console.log(JSON.stringify({
      event: "ch_call",
      source: "cardhedge.client",
      path,
      status: res.status,
      took_ms: Date.now() - t0,
      ok: res.ok,
    }));
    return res;
  } catch (err) {
    console.log(JSON.stringify({
      event: "ch_call",
      source: "cardhedge.client",
      path,
      status: 0,
      took_ms: Date.now() - t0,
      ok: false,
      error: (err as Error)?.message ?? String(err),
    }));
    throw err;
  }
}

export interface CardHedgeCard {
  card_id: string;
  player?: string;
  set?: string;
  /**
   * CardHedge groups cards under a subset (e.g. "Base Set",
   * "Prospect Autographs", "Chrome Prospect Autograph", "Prospect Retail
   * Autograph"). Used by CF-CH-STRUCTURED-SEARCH-MERCY to distinguish
   * auto SKUs from base parallels when the caller's identity specifies
   * isAuto. The interface was previously missing this field despite CH
   * always populating it — the mercy fallback saw them as unknown and
   * picked base cards for auto queries.
   */
  subset?: string;
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
  /** CF-COMP-IMAGE-PHASE-0 (Drew, 2026-07-16): eBay listing thumbnail from
   *  CH's /cards/comps response (field name `image` on CH's side). Threads
   *  through RawComp.imageUrl → recentComps[] on the wire → iOS renders
   *  the actual card image alongside the price. Null when CH omitted it
   *  for a sale (e.g. delisted listing). */
  image_url: string | null;
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
  page = 1,
): Promise<CardHedgeCard[]> {
  const h = headers();
  if (!h) {
    console.warn("[cardhedge.client] CARD_HEDGE_API_KEY missing");
    return [];
  }
  // Filter values folded into the cache key so the same `query` with
  // different structured filters doesn't collide on a stale cached payload.
  // CF-DAILYIQ-BOWMAN-2YR (2026-07-02): page number folded in too so
  // different pages of the same query don't collide.
  const filterKey = filters
    ? [filters.player ?? "", filters.set ?? "", filters.rookie ?? "", String(page)].join("|")
    : `|||${page}`;
  // CF-CH-SEARCH-NO-CACHE-EMPTY (2026-07-01): don't persist a zero-hit
  // result. CardHedge occasionally returns [] on transient conditions
  // (rate-limit backpressure, deploy warmup, transient CDN edge blips),
  // and the prior 6-hour cache TTL would then hold that empty result
  // for 6 hours — turning a transient blip into a persistent picker
  // failure. Observable pre-CF: post-deploy of PR #241, "Pete Alonso
  // Auto" and "Bo Bichette Auto" persistently returned 0/1 candidates
  // while identical direct CH probes returned 50 every time; changing
  // the raw query enough to change the cache key (e.g. adding "rookie")
  // instantly recovered the 50-candidate result. Non-empty results
  // still cache for the full TTL — the cache remains effective for
  // the common case, we just don't LOCK IN empty responses.
  return cacheWrap<CardHedgeCard[]>(
    cacheKey("ch:search", query, String(limit), filterKey),
    async () => _searchCards(query, limit, h, filters, page),
    {
      freshTtlSeconds: SEARCH_TTL_SEC,
      skipCacheWhen: (result) => result.length === 0,
    },
  );
}

async function _searchCards(
  query: string,
  limit: number,
  h: Record<string, string>,
  filters?: CardSearchFilters,
  page = 1,
): Promise<CardHedgeCard[]> {
  try {
    const body: Record<string, unknown> = {
      search: query,
      category: "Baseball",
      page,
      page_size: Math.max(1, Math.min(limit, 50)),
    };
    // CF-CH-STRUCTURED-SEARCH-FILTERS: only emit each filter key when the
    // value is non-empty. CH treats omitted fields as "no filter" — sending
    // an empty string would (per the docs) be a "match empty string" filter.
    if (filters?.player && filters.player.length > 0) body.player = filters.player;
    if (filters?.set && filters.set.length > 0) body.set = filters.set;
    if (filters?.rookie && filters.rookie.length > 0) body.rookie = filters.rookie;

    const res = await chFetch(`${BASE_URL}/cards/card-search`, {
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
    const res = await chFetch(`${BASE_URL}/cards/card-details`, {
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

// ─────────────────────────────────────────────────────────────────────────────
// CF-CH-ALL-PRICES-BY-CARD (2026-07-04): /v1/cards/all-prices-by-card
//
// Returns the latest CH-catalog price for a card at EVERY grade the card
// has data for, in one HTTP call. Response shape (from CH docs):
//   { prices: [{card_id, grade, grader, price, display_order}, ...] }
//
// Value: enables an iOS "show me every grade's current CH price for this
// card" surface in a single call (vs N calls to getPriceEstimate, one per
// grade). Also useful as a floor / discovery signal when our own
// gradedEstimates come back thin.
//
// Semantics: these are CH's MODEL PRICES (not observed sold comps). Per
// project memory (project_engine_owns_signals_not_ch_product), we do NOT
// substitute these for our engine FMV. This is a display / enrichment
// signal, not a training signal.
// ─────────────────────────────────────────────────────────────────────────────

export interface CardHedgeGradePriceRow {
  card_id: string;
  grade: string;
  grader: string | null;
  price: number;
  /** CH's suggested UI ordering for the grade rail (Raw=-1, PSA10=1, PSA9=2, …).
   *  Callers can sort by this or by our own convention. Numeric with string
   *  values normalized. */
  display_order: number | null;
}

export async function getAllPricesByCard(
  cardId: string,
): Promise<CardHedgeGradePriceRow[]> {
  const h = headers();
  if (!h || !cardId) return [];
  return cacheWrap(
    cacheKey("ch:all-prices-by-card", cardId),
    async () => _getAllPricesByCard(cardId, h),
    FMV_TTL_SEC,
  );
}

async function _getAllPricesByCard(
  cardId: string,
  h: Record<string, string>,
): Promise<CardHedgeGradePriceRow[]> {
  try {
    const res = await chFetch(`${BASE_URL}/cards/all-prices-by-card`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ card_id: cardId }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        `[cardhedge.client] all-prices-by-card HTTP ${res.status} for card_id=${cardId}`,
      );
      return [];
    }
    const body: any = await res.json();
    const arr: any[] = Array.isArray(body?.prices) ? body.prices : [];
    return arr
      .map((p) => {
        const priceNum = toFloat(p?.price);
        const displayOrderRaw = p?.display_order;
        const displayOrder =
          typeof displayOrderRaw === "number"
            ? displayOrderRaw
            : typeof displayOrderRaw === "string" && displayOrderRaw.trim() !== ""
              ? Number(displayOrderRaw)
              : NaN;
        return {
          card_id: typeof p?.card_id === "string" ? p.card_id : cardId,
          grade: typeof p?.grade === "string" ? p.grade : "",
          grader: typeof p?.grader === "string" ? p.grader : null,
          price: priceNum,
          display_order: Number.isFinite(displayOrder) ? displayOrder : null,
        };
      })
      .filter((r) => r.grade && r.price > 0);
  } catch (err: any) {
    console.warn(
      `[cardhedge.client] all-prices-by-card threw for card_id=${cardId}:`,
      err?.message ?? err,
    );
    return [];
  }
}

// ── BATCH ENDPOINTS (CF-CH-BATCH-PORTFOLIO-REFRESH 2026-06-30) ────────────
//
// CH supports up to 100 (card_id, grade) pairs per request for both FMV and
// price-estimate, and up to 100 certificate numbers per cert-batch call.
// Using these in the portfolio refresh path is a 10-50× CH call reduction:
// today the refresh fans out one HTTP call per holding (500-card portfolio
// = 500 calls); batched, the same portfolio takes 5-10 calls.
//
// Cache strategy: batch wrappers do NOT cache the full response (the key
// would have to be the sorted item set — rarely identical across calls).
// Callers are expected to manage per-item caching with the existing
// getCardFmv / getPriceEstimate wrappers when individual cache hits matter
// (e.g., the hot path serving compiq routes). The batch wrappers are
// optimized for the BULK refresh case where everything is being re-priced.

/** Per-item input for the batch FMV / price-estimate endpoints. */
export interface CardHedgeBatchItem {
  cardId: string;
  grade: string;
}

/** Per-item result from /v1/cards/card-fmv-batch. Mirrors CH's
 *  BatchFMVResultItem: each item carries the input echo + an FMV payload
 *  (when found) or an error string (when not). The status field is the
 *  authoritative success/failure flag — `fmv` may be null even on
 *  status="success" if CH lacks data for that grade. */
export interface CardHedgeBatchFmvResult {
  card_id: string;
  grade: string;
  status: "success" | "error" | "not_found" | string;
  fmv: CardHedgeFmv | null;
  error?: string | null;
}

export interface CardHedgeBatchFmvResponse {
  results: CardHedgeBatchFmvResult[];
  total_requested: number;
  total_successful: number;
}

/** Per-item result from /v1/cards/batch-price-estimate. Same envelope
 *  shape as the FMV variant; the `estimate` field carries the per-item
 *  payload. */
export interface CardHedgeBatchEstimateResult {
  card_id: string;
  grade: string;
  status: "success" | "error" | "not_found" | string;
  estimate: CardHedgePriceEstimate | null;
  error?: string | null;
}

export interface CardHedgeBatchEstimateResponse {
  results: CardHedgeBatchEstimateResult[];
  total_requested: number;
  total_successful: number;
}

/** Per-item result from /v1/cards/batch-prices-by-cert. */
export interface CardHedgeCertPriceResult {
  cert_info: {
    cert_number: string;
    grader: string;
    grade?: string | null;
    [k: string]: unknown;
  };
  card: { card_id?: string; description?: string; [k: string]: unknown } | null;
  price: number | null;
  price_low: number | null;
  price_high: number | null;
  confidence: number | null;
  method: string | null;
  card_source: "gemrate_id" | "card_match" | string | null;
  match_confidence: number | null;
}

export interface CardHedgeCertPriceResponse {
  results: CardHedgeCertPriceResult[];
  total_requested: number;
  total_found: number;
}

/** Single price-update event from /v1/cards/price-updates (delta poll). */
export interface CardHedgePriceUpdate {
  card_id: string;
  card_desc: string;
  card_set: string;
  card_number: string;
  player: string;
  variant: string;
  grade: string;
  price: string;        // CH ships as string — caller coerces
  sale_date: string;    // YYYY-MM-DD
  update_timestamp: string;
}

export interface CardHedgePriceUpdatesResponse {
  updates: CardHedgePriceUpdate[];
  count: number;
}

// CF-CH-DELTA-POLL-FOUNDATION (2026-06-30): per-subscription input shape
// for /cards/subscribe-price-updates. external_id is OUR reference for
// the subscription (defaults to card_id when omitted) — we use it to
// thread the holding id back through the update feed so the delta-poll
// worker can match updates to portfolio holdings.
export interface CardHedgeSubscriptionItem {
  cardId: string;
  grade: string;
  /** Optional external reference. Defaults to cardId server-side. We
   *  pass `{holdingId}:{cardId}:{grade}` so updates can be reverse-
   *  mapped to specific holdings. */
  externalId?: string;
}

export interface CardHedgeSubscriptionResult {
  card_id: string;
  grade: string;
  status: "success" | "error" | string;
  external_id?: string | null;
  error?: string | null;
}

export interface CardHedgeSubscribeResponse {
  results: CardHedgeSubscriptionResult[];
  total_requested: number;
  total_successful: number;
}

/** Internal: POST a batch request with up to N items and return the typed
 *  response. Splits oversized batches into chunks of CH's max (100) and
 *  concatenates the result arrays — caller doesn't need to know about
 *  the cap. Non-fatal: a chunk failure → that chunk omitted, others kept.
 *
 *  CH uses two slightly different total-field names: `total_successful`
 *  for FMV/estimate batches, `total_found` for cert batches. The merger
 *  reads both from the raw body and pumps them back into the response
 *  via bracket access — keeps each endpoint's response type clean
 *  without forcing a fake field into the shape.
 */
async function _postBatchChunks<TItem, TResult, TResp extends { results: TResult[]; total_requested: number }>(
  path: string,
  items: TItem[],
  buildBody: (chunk: TItem[]) => Record<string, unknown>,
  emptyResponse: () => TResp,
  h: Record<string, string>,
  totalField: "total_successful" | "total_found",
  chunkSize = 100,
): Promise<TResp | null> {
  if (items.length === 0) return emptyResponse();
  const merged = emptyResponse();
  // Dynamic field — cast through `any` for the bracket access. The
  // emptyResponse factory already seeded `totalField` to 0; we just
  // accumulate per-chunk increments.
  const mergedAny = merged as unknown as Record<string, number | unknown>;
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    try {
      const res = await chFetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: h,
        body: JSON.stringify(buildBody(chunk)),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.warn(`[cardhedge.client] ${path} HTTP ${res.status} (chunk ${i}-${i + chunk.length})`);
        continue;
      }
      const body: any = await res.json();
      const chunkResults: TResult[] = Array.isArray(body?.results) ? body.results : [];
      merged.results.push(...chunkResults);
      merged.total_requested += Number(body?.total_requested ?? chunk.length) || chunk.length;
      const prior = Number(mergedAny[totalField]) || 0;
      mergedAny[totalField] = prior + (Number(body?.[totalField] ?? 0) || 0);
    } catch (err: any) {
      console.warn(`[cardhedge.client] ${path} threw on chunk ${i}:`, err?.message ?? err);
    }
  }
  return merged;
}

/**
 * Batch FMV lookup. Accepts any number of items; transparently chunks at
 * CH's 100-item limit. Order of results MAY differ from input — caller
 * should re-index by (card_id, grade) when matching back to holdings.
 */
export async function getCardFmvBatch(
  items: CardHedgeBatchItem[],
): Promise<CardHedgeBatchFmvResponse | null> {
  const h = headers();
  if (!h) return null;
  const valid = items.filter((it) => it?.cardId && it?.grade);
  return _postBatchChunks<CardHedgeBatchItem, CardHedgeBatchFmvResult, CardHedgeBatchFmvResponse>(
    "/cards/card-fmv-batch",
    valid,
    (chunk) => ({ items: chunk.map((it) => ({ card_id: it.cardId, grade: it.grade })) }),
    () => ({ results: [], total_requested: 0, total_successful: 0 }),
    h,
    "total_successful",
  );
}

/** Batch price-estimate. Same shape as getCardFmvBatch but routes to the
 *  correlated price-estimation service instead of the FMV service. Use
 *  this for grade-ladder reconstruction; use card-fmv-batch for the
 *  authoritative valuation that ships to iOS. */
export async function getBatchPriceEstimate(
  items: CardHedgeBatchItem[],
): Promise<CardHedgeBatchEstimateResponse | null> {
  const h = headers();
  if (!h) return null;
  const valid = items.filter((it) => it?.cardId && it?.grade);
  return _postBatchChunks<CardHedgeBatchItem, CardHedgeBatchEstimateResult, CardHedgeBatchEstimateResponse>(
    "/cards/batch-price-estimate",
    valid,
    (chunk) => ({ items: chunk.map((it) => ({ card_id: it.cardId, grade: it.grade })) }),
    () => ({ results: [], total_requested: 0, total_successful: 0 }),
    h,
    "total_successful",
  );
}

/** Batch cert-number price lookup. CH resolves each cert → card via GemRate
 *  and emits a price estimate. `grader` defaults to PSA on CH's side. */
export async function getBatchPricesByCert(
  certs: string[],
  grader?: string,
): Promise<CardHedgeCertPriceResponse | null> {
  const h = headers();
  if (!h) return null;
  const valid = certs.filter((c) => typeof c === "string" && c.trim().length > 0).map((c) => c.trim());
  return _postBatchChunks<string, CardHedgeCertPriceResult, CardHedgeCertPriceResponse>(
    "/cards/batch-prices-by-cert",
    valid,
    (chunk) => ({ certs: chunk, ...(grader ? { grader } : {}) }),
    () => ({ results: [], total_requested: 0, total_found: 0 }),
    h,
    "total_found",
  );
}

/**
 * Delta poll: fetch price updates since the given ISO timestamp. Returns
 * only cards CH has been subscribed to via subscribe-price-updates;
 * unsubscribed cards never appear here.
 *
 * NO cache: by design, delta polls should be fresh. The caller is
 * expected to record the latest observed `update_timestamp` and pass it
 * as `since` on the next call.
 */
export async function getPriceUpdates(
  since: string,
  opts: { ignoreGrades?: string[] } = {},
): Promise<CardHedgePriceUpdatesResponse | null> {
  const h = headers();
  if (!h || !since) return null;
  try {
    const body: Record<string, unknown> = { since };
    if (Array.isArray(opts.ignoreGrades) && opts.ignoreGrades.length > 0) {
      body.ignore_grades = opts.ignoreGrades;
    }
    const res = await chFetch(`${BASE_URL}/cards/price-updates`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[cardhedge.client] price-updates HTTP ${res.status}`);
      return null;
    }
    const respBody: any = await res.json();
    return {
      updates: Array.isArray(respBody?.updates) ? respBody.updates : [],
      count: typeof respBody?.count === "number" ? respBody.count : 0,
    };
  } catch (err: any) {
    console.warn("[cardhedge.client] price-updates threw:", err?.message ?? err);
    return null;
  }
}

/**
 * Subscribe (card_id, grade) combinations to CardHedge's price tracking.
 * Once subscribed, sales appear in the delta-poll feed served by
 * getPriceUpdates(). Each subscription carries an external_id which CH
 * echoes back in the update payload — we use it to reverse-map updates
 * to holdings.
 *
 * REQUIRES CARD_HEDGE_CLIENT_ID env var. Returns null when unset (the
 * delta-poll worker treats null as "subscriptions are not enrolled yet"
 * and stays dormant).
 *
 * CH supports up to 100 subscriptions per request; we chunk transparently.
 */
export async function subscribePriceUpdates(
  subscriptions: CardHedgeSubscriptionItem[],
): Promise<CardHedgeSubscribeResponse | null> {
  const h = headers();
  const clientId = process.env.CARD_HEDGE_CLIENT_ID;
  if (!h) return null;
  if (!clientId) {
    console.warn("[cardhedge.client] subscribe-price-updates skipped — CARD_HEDGE_CLIENT_ID unset");
    return null;
  }
  const valid = subscriptions.filter((s) => s?.cardId && s?.grade);
  if (valid.length === 0) return { results: [], total_requested: 0, total_successful: 0 };

  const merged: CardHedgeSubscribeResponse = { results: [], total_requested: 0, total_successful: 0 };
  for (let i = 0; i < valid.length; i += 100) {
    const chunk = valid.slice(i, i + 100);
    try {
      const res = await chFetch(`${BASE_URL}/cards/subscribe-price-updates`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({
          client_id: clientId,
          subscriptions: chunk.map((s) => ({
            card_id: s.cardId,
            grade: s.grade,
            ...(s.externalId ? { external_id: s.externalId } : {}),
          })),
        }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.warn(`[cardhedge.client] subscribe-price-updates HTTP ${res.status} (chunk ${i}-${i + chunk.length})`);
        continue;
      }
      const body: any = await res.json();
      const chunkResults: CardHedgeSubscriptionResult[] = Array.isArray(body?.results) ? body.results : [];
      merged.results.push(...chunkResults);
      merged.total_requested += Number(body?.total_requested ?? chunk.length) || chunk.length;
      merged.total_successful += Number(body?.total_successful ?? 0) || 0;
    } catch (err: any) {
      console.warn(`[cardhedge.client] subscribe-price-updates threw on chunk ${i}:`, err?.message ?? err);
    }
  }
  return merged;
}

async function _postFmvShape<T extends { price: number }>(
  path: string,
  body: Record<string, unknown>,
  h: Record<string, string>,
): Promise<T | null> {
  try {
    const res = await chFetch(`${BASE_URL}${path}`, {
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
  return cacheWrap<SalesStatsByPlayerResponse | null>(
    cacheKey("ch:sales-stats", category, interval, players.slice().sort().join(",")),
    async () =>
      _postTyped<SalesStatsByPlayerResponse>(
        "/cards/sales-stats-by-player",
        { players, interval, category },
        h,
      ),
    {
      freshTtlSeconds: TREND_TTL_SEC,
      // CF-SALES-STATS-NO-CACHE-EMPTY (2026-07-02): don't lock in a
      // transient empty response for 12 hours. Same class as PR #242
      // (CF-CH-SEARCH-NO-CACHE-EMPTY) — CH batch endpoints can drop to
      // 0 results on transient conditions (rate-limit backpressure,
      // silent batch-size ceiling, deploy warmup); the fresh-TTL cache
      // then holds that empty for the full window. skipCacheWhen lets
      // the next call self-heal.
      skipCacheWhen: (r) => !r || !Array.isArray(r.results) || r.results.length === 0,
    },
  );
}

/**
 * CF-CH-TOTAL-SALES-BATCH-LIMIT (2026-07-02): CardHedge's
 * `/cards/total-sales-by-player` silently returns `{results:[], days:null}`
 * when the request body carries more than ~20 players (empirically verified:
 * 20 works, 30 returns empty; no error, no HTTP failure — just an empty
 * results array). The DailyIQ matched-cohort job was passing all 60+
 * portfolio players in one call and getting nothing back — `topVolume30d`
 * silently held zero rows for the entire lifetime of that cache entry.
 *
 * Fix: chunk internally at 20 players per HTTP call, run the chunks
 * concurrently (bounded by CH's own rate handling), and merge the
 * results back into a single response. Cache key still keyed on the
 * FULL sorted player list so callers get identical cache semantics.
 * When a chunk fails, its rows are simply absent from the merged
 * results — never propagate one chunk's failure into whole-response
 * failure (partial data is preferable to zero data for this signal).
 */
const TOTAL_SALES_BATCH_MAX = 20;
/**
 * CF-TOTAL-SALES-THROTTLE (2026-07-02): 27+ concurrent chunks (after
 * CF-DAILYIQ-BOWMAN-2YR widened the fetch to ~530 players) started
 * timing out — CH couldn't service that many concurrent connections.
 * Cap concurrent chunks at 5; total wall-clock for 27 chunks becomes
 * ~5 × (chunk latency ~2s) = 10 sec, well under any timeout, and CH's
 * per-chunk work stays comfortably below its rate ceiling.
 */
const TOTAL_SALES_CONCURRENCY = 5;

/**
 * Bounded-concurrency map. Runs `fn(item)` for each item with at most
 * `concurrency` running at once. Preserves input order in the output.
 */
async function boundedMap<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const width = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

async function _fetchTotalSalesChunk(
  players: string[],
  category: string,
  h: Record<string, string>,
): Promise<TotalSalesByPlayerResponse | null> {
  try {
    return await _postTyped<TotalSalesByPlayerResponse>(
      "/cards/total-sales-by-player",
      { players, category },
      h,
    );
  } catch (err) {
    console.warn(
      `[cardhedge.client] total-sales chunk failed (${players.length} players): ${(err as Error)?.message ?? err}`,
    );
    return null;
  }
}

export async function getTotalSalesByPlayer(
  players: string[],
  category: string = "Baseball",
): Promise<TotalSalesByPlayerResponse | null> {
  const h = headers();
  if (!h || !players?.length) return null;
  return cacheWrap<TotalSalesByPlayerResponse>(
    cacheKey("ch:total-sales", category, players.slice().sort().join(",")),
    async () => {
      const chunks: string[][] = [];
      for (let i = 0; i < players.length; i += TOTAL_SALES_BATCH_MAX) {
        chunks.push(players.slice(i, i + TOTAL_SALES_BATCH_MAX));
      }
      // CF-TOTAL-SALES-THROTTLE (2026-07-02): bounded concurrency to
      // prevent CH from timing out under 27+ concurrent connections.
      const chunkResults = await boundedMap(
        chunks,
        TOTAL_SALES_CONCURRENCY,
        (c) => _fetchTotalSalesChunk(c, category, h),
      );
      const merged: TotalSalesByPlayerResult[] = [];
      let days: number | null = null;
      for (const r of chunkResults) {
        if (!r) continue;
        if (Array.isArray(r.results)) merged.push(...r.results);
        if (days === null && typeof r.days === "number") days = r.days;
      }
      return {
        results: merged,
        days: days ?? 30,
      } satisfies TotalSalesByPlayerResponse;
    },
    {
      freshTtlSeconds: TREND_TTL_SEC,
      // CF-SALES-STATS-NO-CACHE-EMPTY (2026-07-02): pre-#244 cycles
      // cached an empty response (from CH's silent batch-size cutoff),
      // and PR #244's internal chunking never got to run because
      // cacheWrap served the poison before the chunker fired. Same
      // pattern as PR #242 — never lock in an empty result.
      skipCacheWhen: (r) => !r || r.results.length === 0,
    },
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
        const res = await chFetch(`${BASE_URL}/cards/top-movers?${params.toString()}`, {
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
    const res = await chFetch(`${BASE_URL}${path}`, {
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
// ── IMAGE + CERT-OCR ENDPOINTS (CF-CH-IMAGE-CERT-OCR 2026-06-30) ───────────
//
// Foundation for iOS slab scanning. CH exposes 4 image-based identification
// endpoints; we wrap them so the future /api/compiq/scan route (and any
// other photo-driven flow) can call uniformly.
//
// All 4 take EITHER imageUrl (public URL, faster — CH downloads once) OR
// imageBase64 (data the iOS app already has in-memory, no upload round-
// trip). At least one is required; the wrapper rejects with null if both
// missing. base64 payloads bypass our cache layer (each photo is unique);
// imageUrl is cached by URL hash for a short window (URLs CAN repeat
// in iOS — the photo storage layer issues persistent SAS URLs).
//
// LATENCY: AI vision + match is slower than text — bump the per-call
// timeout to 30s. NO retries internally; the caller decides whether a
// timeout warrants a retry (often it doesn't — the user can re-tap).
//
// PRIVACY: never log image_url with query strings (they often carry SAS
// signatures) and never log image_base64 content. Errors log only the
// endpoint path + HTTP status.
const IMAGE_OP_TIMEOUT_MS = 30_000;
const IMAGE_MATCH_TTL_SEC = 10 * 60;  // 10 min — same image_url likely tapped multiple times by an active user

export interface ImageInput {
  /** Public URL of the card image. Preferred when iOS has already
   *  uploaded the photo via the existing photo-storage pipeline. */
  imageUrl?: string;
  /** Base64-encoded image bytes (data-URI prefix optional). Use when
   *  the iOS app wants to skip the upload round-trip. */
  imageBase64?: string;
}

/** Per the AI's choice — best card it could resolve from the image. */
export interface CardHedgeImageBestMatch {
  card_id?: string;
  description?: string;
  player?: string;
  set?: string;
  number?: string;
  variant?: string;
  confidence?: number;
  [k: string]: unknown;
}

export interface CardHedgeImageMatchResponse {
  success: boolean;
  best_match: CardHedgeImageBestMatch | null;
  candidates: CardHedgeImageBestMatch[];
  query_id?: string;
  message?: string;
}

export interface CardHedgeImageSearchResult {
  card_id?: string;
  description?: string;
  player?: string;
  set?: string;
  number?: string;
  variant?: string;
  similarity?: number;
  [k: string]: unknown;
}

export interface CardHedgeImageSearchResponse {
  success: boolean;
  results: CardHedgeImageSearchResult[];
  total_results: number;
  query_id?: string;
  has_cardhedge_matches?: boolean;
  message?: string;
}

export interface CardHedgeCertOcrCertInfo {
  cert_number?: string;
  grader?: string;
  grade?: string | null;
  [k: string]: unknown;
}

export interface CardHedgeCertOcrDetailsResponse {
  cert_info: CardHedgeCertOcrCertInfo;
  card: { card_id?: string; description?: string; [k: string]: unknown } | null;
  card_source?: "gemrate_id" | "card_match" | string | null;
  match_confidence?: number | null;
}

export interface CardHedgeCertOcrPriceResponse extends CardHedgeCertOcrDetailsResponse {
  prices: Array<{
    grade?: string;
    sale_date?: string;
    price?: string | number;
    [k: string]: unknown;
  }>;
}

/** Internal: build the request body from an ImageInput, returning null
 *  if neither field is populated. Trims whitespace. */
function buildImageBody(input: ImageInput, extras?: Record<string, unknown>): Record<string, unknown> | null {
  const url = typeof input.imageUrl === "string" ? input.imageUrl.trim() : "";
  const b64 = typeof input.imageBase64 === "string" ? input.imageBase64.trim() : "";
  if (!url && !b64) return null;
  const body: Record<string, unknown> = { ...(extras ?? {}) };
  if (url) body.image_url = url;
  if (b64) body.image_base64 = b64;
  return body;
}

/** Cheap stable hash of imageUrl for cache key segmentation. We avoid
 *  embedding the full URL because some contain long SAS signatures. */
function imageCacheKeyPart(input: ImageInput): string {
  const url = typeof input.imageUrl === "string" ? input.imageUrl.trim() : "";
  if (!url) return "b64";  // base64 requests bypass cache (see callers)
  // Strip query string before hashing — SAS signatures rotate; we want
  // the same underlying blob URL to cache-hit across signature refreshes.
  const base = url.split("?")[0] || url;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = ((h << 5) - h + base.charCodeAt(i)) | 0;
  return `url:${(h >>> 0).toString(16)}`;
}

/** Shared POST → JSON for image endpoints. Returns null on error.
 *  Never logs URL query string or base64 content. */
async function _postImageEndpoint<T>(
  path: string,
  body: Record<string, unknown>,
  h: Record<string, string>,
): Promise<T | null> {
  try {
    const res = await chFetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(IMAGE_OP_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[cardhedge.client] ${path} HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err: any) {
    console.warn(`[cardhedge.client] ${path} threw: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * AI-pick the single best card match for an image. Use this for the iOS
 * raw-card scan flow ("take a photo of the card you want priced").
 *
 * `k` controls AI breadth (default 10 — wider = slower, more accurate).
 * Returns null on transport failure; the success path's `best_match`
 * can still be null when the AI isn't confident enough.
 */
export async function identifyCardByImage(
  input: ImageInput,
  opts: { k?: number } = {},
): Promise<CardHedgeImageMatchResponse | null> {
  const h = headers();
  if (!h) return null;
  const body = buildImageBody(input, opts.k != null ? { k: opts.k } : undefined);
  if (!body) {
    console.warn("[cardhedge.client] identifyCardByImage: imageUrl OR imageBase64 required");
    return null;
  }
  // base64 inputs bypass cache (per-call unique); imageUrl inputs cache
  // by hashed URL stem to dedupe a user tapping the same blob twice.
  if (body.image_base64) {
    return _postImageEndpoint<CardHedgeImageMatchResponse>("/cards/image-match", body, h);
  }
  return cacheWrap(
    cacheKey("ch:image-match", imageCacheKeyPart(input), String(opts.k ?? 10)),
    () => _postImageEndpoint<CardHedgeImageMatchResponse>("/cards/image-match", body, h),
    IMAGE_MATCH_TTL_SEC,
  );
}

/**
 * Ranked list of visually similar cards. Use when the iOS user wants to
 * BROWSE candidates rather than commit to one — e.g., disambiguating
 * variants of the same card.
 */
export async function searchCardsByImage(
  input: ImageInput,
  opts: { k?: number } = {},
): Promise<CardHedgeImageSearchResponse | null> {
  const h = headers();
  if (!h) return null;
  const body = buildImageBody(input, opts.k != null ? { k: opts.k } : undefined);
  if (!body) {
    console.warn("[cardhedge.client] searchCardsByImage: imageUrl OR imageBase64 required");
    return null;
  }
  if (body.image_base64) {
    return _postImageEndpoint<CardHedgeImageSearchResponse>("/cards/image-search", body, h);
  }
  return cacheWrap(
    cacheKey("ch:image-search", imageCacheKeyPart(input), String(opts.k ?? 10)),
    () => _postImageEndpoint<CardHedgeImageSearchResponse>("/cards/image-search", body, h),
    IMAGE_MATCH_TTL_SEC,
  );
}

/**
 * Extract grader + cert number from a SLABBED card image via AI OCR,
 * then resolve card details (no price history — see
 * getPricesByCertImage for that). Use this for the iOS graded-card
 * scan flow.
 */
export async function getCardDetailsByCertImage(
  input: ImageInput,
): Promise<CardHedgeCertOcrDetailsResponse | null> {
  const h = headers();
  if (!h) return null;
  const body = buildImageBody(input);
  if (!body) {
    console.warn("[cardhedge.client] getCardDetailsByCertImage: imageUrl OR imageBase64 required");
    return null;
  }
  if (body.image_base64) {
    return _postImageEndpoint<CardHedgeCertOcrDetailsResponse>("/cards/details-by-cert-ocr", body, h);
  }
  return cacheWrap(
    cacheKey("ch:cert-ocr-details", imageCacheKeyPart(input)),
    () => _postImageEndpoint<CardHedgeCertOcrDetailsResponse>("/cards/details-by-cert-ocr", body, h),
    IMAGE_MATCH_TTL_SEC,
  );
}

/**
 * Same OCR pipeline as getCardDetailsByCertImage but also returns
 * recent prices for the resolved cert. Use this for the iOS scan-to-
 * value flow on graded slabs.
 *
 * `days` controls the price-history window (1-365, default 90 on CH's
 * side — we don't override unless caller asks).
 */
export async function getPricesByCertImage(
  input: ImageInput,
  opts: { days?: number } = {},
): Promise<CardHedgeCertOcrPriceResponse | null> {
  const h = headers();
  if (!h) return null;
  const body = buildImageBody(
    input,
    opts.days != null && Number.isFinite(opts.days) ? { days: Math.max(1, Math.min(365, Math.floor(opts.days))) } : undefined,
  );
  if (!body) {
    console.warn("[cardhedge.client] getPricesByCertImage: imageUrl OR imageBase64 required");
    return null;
  }
  if (body.image_base64) {
    return _postImageEndpoint<CardHedgeCertOcrPriceResponse>("/cards/prices-by-cert-ocr", body, h);
  }
  return cacheWrap(
    cacheKey("ch:cert-ocr-prices", imageCacheKeyPart(input), String(opts.days ?? 90)),
    () => _postImageEndpoint<CardHedgeCertOcrPriceResponse>("/cards/prices-by-cert-ocr", body, h),
    IMAGE_MATCH_TTL_SEC,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CF-CH-ADDITIONS-SUMMARY (2026-07-04): daily catalog-addition counts
//
// Powers the "new releases" feed. Groups new-card additions by
// (category, set_name, subset, variants) per day. Callers filter by
// category / set / date range and paginate.
// ─────────────────────────────────────────────────────────────────────────────

export interface CardHedgeAdditionRow {
  category: string;
  set_name: string;
  subset: string | null;
  variants: string | null;
  added_date: string;
  card_count: number;
}

export interface CardHedgeAdditionsResponse {
  data: CardHedgeAdditionRow[];
  page: number;
  page_size: number;
}

const ADDITIONS_TTL_SEC = 6 * 3600; // 6h — catalog additions cadence is daily

export async function getAdditionsSummary(opts: {
  startDate: string;
  endDate?: string;
  category?: string;
  setName?: string;
  page?: number;
  pageSize?: number;
}): Promise<CardHedgeAdditionsResponse | null> {
  const h = headers();
  if (!h || !opts.startDate) return null;
  const body: Record<string, unknown> = {
    start_date: opts.startDate,
    ...(opts.endDate ? { end_date: opts.endDate } : {}),
    ...(opts.category ? { category: opts.category } : {}),
    ...(opts.setName ? { set_name: opts.setName } : {}),
    page: opts.page ?? 1,
    page_size: opts.pageSize ?? 50,
  };
  const key = cacheKey(
    "ch:additions-summary",
    opts.startDate,
    opts.endDate ?? "",
    opts.category ?? "",
    opts.setName ?? "",
    String(opts.page ?? 1),
    String(opts.pageSize ?? 50),
  );
  return cacheWrap(
    key,
    async () => _postAdditionsSummary(body, h),
    ADDITIONS_TTL_SEC,
  );
}

async function _postAdditionsSummary(
  body: Record<string, unknown>,
  h: Record<string, string>,
): Promise<CardHedgeAdditionsResponse | null> {
  try {
    const res = await chFetch(`${BASE_URL}/cards/additions-summary`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[cardhedge.client] additions-summary HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as any;
    return {
      data: Array.isArray(data?.data) ? data.data : [],
      page: typeof data?.page === "number" ? data.page : 1,
      page_size: typeof data?.page_size === "number" ? data.page_size : 50,
    };
  } catch (err: any) {
    console.warn(`[cardhedge.client] additions-summary threw:`, err?.message ?? err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CF-CH-CERT-NUMBER-LOOKUP (2026-07-04): cert-number → card + prices
//
// Non-image sibling to the getCardDetailsByCertImage / getPricesByCertImage
// pair. Used when iOS has a cert number typed (or scanned via barcode) but
// no photo of the slab. Under the hood CH's cert lookup routes through
// GemRate to resolve card identity → then joins price history.
//
// Grader is required (PSA / BGS / SGC / CGC). Cert is the alphanumeric
// cert# printed on the slab. `days` on prices-by-cert bounds the history
// window (defaults 90 CH-side).
// ─────────────────────────────────────────────────────────────────────────────

/** Shared cert-lookup shape returned by both fmv-by-cert and prices-by-cert. */
export interface CardHedgeCertInfo {
  grader: string;
  cert: string;
  grade: string;
  gemrate_id?: string | null;
  universal_gemrate_id?: string | null;
  description?: string | null;
}

export interface CardHedgeCertCard {
  card_id: string;
  description?: string | null;
  player?: string | null;
  set?: string | null;
  number?: string | null;
  variant?: string | null;
  image?: string | null;
  category?: string | null;
}

export interface CardHedgeFmvByCertResponse {
  cert_info: CardHedgeCertInfo;
  card: CardHedgeCertCard | null;
  fmv: CardHedgeFmv | null;
  card_source?: string | null;
  match_confidence?: number | null;
}

export interface CardHedgeCertPriceRow {
  price: number;
  date: string | null;
  source: string | null;
  sale_type: string | null;
  title: string | null;
  url: string | null;
}

export interface CardHedgePricesByCertResponse {
  cert_info: CardHedgeCertInfo;
  card: CardHedgeCertCard | null;
  prices: CardHedgeCertPriceRow[];
  card_source?: string | null;
  match_confidence?: number | null;
}

const CERT_LOOKUP_TTL_SEC = 24 * 3600; // 24h — cert identity is stable

export async function getFmvByCert(
  cert: string,
  grader: string,
): Promise<CardHedgeFmvByCertResponse | null> {
  const h = headers();
  if (!h || !cert || !grader) return null;
  return cacheWrap(
    cacheKey("ch:fmv-by-cert", cert, grader),
    async () => _postCertEndpoint<CardHedgeFmvByCertResponse>("/cards/fmv-by-cert", { cert, grader }, h),
    CERT_LOOKUP_TTL_SEC,
  );
}

export async function getPricesByCert(
  cert: string,
  grader: string,
  opts: { days?: number } = {},
): Promise<CardHedgePricesByCertResponse | null> {
  const h = headers();
  if (!h || !cert || !grader) return null;
  const days =
    opts.days != null && Number.isFinite(opts.days)
      ? Math.max(1, Math.min(365, Math.floor(opts.days)))
      : 90;
  return cacheWrap(
    cacheKey("ch:prices-by-cert", cert, grader, String(days)),
    async () => _postCertEndpoint<CardHedgePricesByCertResponse>(
      "/cards/prices-by-cert",
      { cert, grader, days },
      h,
    ),
    CERT_LOOKUP_TTL_SEC,
  );
}

async function _postCertEndpoint<T>(
  path: string,
  body: Record<string, unknown>,
  h: Record<string, string>,
): Promise<T | null> {
  try {
    const res = await chFetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[cardhedge.client] ${path} HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as T;
    return data;
  } catch (err: any) {
    console.warn(`[cardhedge.client] ${path} threw:`, err?.message ?? err);
    return null;
  }
}

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
    const res = await chFetch(`${BASE_URL}/cards/card-match`, {
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

/** POST /cards/comps — sold comps with raw prices in DOLLARS.
 *
 *  CF-PERSIST-VENDOR-LOOKUPS (Drew, 2026-07-23, issue #722 phase 2):
 *  when callers pass persistIdentity, the returned sales stream to
 *  sold_comps via persistVendorSalesInBackground so every CH query
 *  grows our own pool. Gated by PERSIST_VENDOR_LOOKUPS_ENABLED. */
export async function getCardSales(
  cardId: string,
  grade: string = "Raw",
  limit: number = 20,
  opts: {
    persistIdentity?: {
      playerName?: string | null;
      cardYear?: number | null;
      sport?: string | null;
    };
  } = {},
): Promise<CardHedgeSale[]> {
  const h = headers();
  if (!h) return [];
  const sales = await cacheWrap(
    cacheKey("ch:comps", cardId, grade, String(limit)),
    async () => _getCardSales(cardId, grade, limit, h),
    COMPS_TTL_SEC,
  );
  if (opts.persistIdentity && sales.length > 0) {
    import("../portfolioiq/persistVendorSalesToPool.service.js")
      .then(({ persistVendorSalesInBackground }) => {
        persistVendorSalesInBackground(
          "cardhedge",
          sales.map((s) => ({
            title: s.title,
            price: s.price,
            soldAt: s.date,
            url: s.url,
          })),
          { ...opts.persistIdentity!, vendorCardId: cardId },
        );
      })
      .catch(() => { /* silent no-op on import failure */ });
  }
  return sales;
}

async function _getCardSales(
  cardId: string,
  grade: string,
  limit: number,
  h: Record<string, string>,
): Promise<CardHedgeSale[]> {
  try {
    const res = await chFetch(`${BASE_URL}/cards/comps`, {
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
        // CF-COMP-IMAGE-PHASE-0: CH's /cards/comps returns the eBay
        // thumbnail under `image` (verified 2026-07-16 probe); the
        // daily-price-export CSV uses `image_url`. Read both defensively
        // so a future CH rename doesn't silently null the field.
        image_url: s.image ?? s.image_url ?? null,
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
    const res = await chFetch(`${BASE_URL}/cards/prices-by-card`, {
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

/**
 * CF-CH-TRUST-WINDOW-90 (2026-07-01): default trust window widened from
 * hardcoded 30d to 90d. Prod App Insights showed 32 no_real_data
 * rejections in 6h all against GOAT-tier / low-turnover cards (Mike
 * Trout 2009 BC auto, Griffey 1989 UD, Franco 2019 BDC, Acuna 2017
 * Bowman) — direct CH probes confirmed ≥1 sale in 90d window but zero
 * in 30d. Widening restores trust for cards that CH has real data on
 * but that turn over infrequently. Env-tunable via CH_TRUST_WINDOW_DAYS
 * (rollback: set to "30"). Recency signal preserved: only the trust
 * gate widens; aggregate daily-series computation is unaffected.
 */
export function resolveTrustWindowDays(): number {
  const raw = Number(process.env.CH_TRUST_WINDOW_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 90;
}

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

  const series = await getPricesByCard(cardId, grade, resolveTrustWindowDays());

  // CF-CH-THIN-SKU-COMPS-RECOVERY (2026-07-04): originally this path
  // early-returned no_real_data when prices-by-card was empty, on the
  // assumption that any getCardSales response for such a card_id would
  // be blob fallback. But CH's /cards/comps returns REAL raw sales
  // for thin SKUs where daily aggregation doesn't fire — the 2026-07-03
  // Hartman LogoFractor case: 0 prices-by-card, 3 real ebay sales at
  // $825, $1251, $900 (median ~$900 vs the engine's sibling-pool $9).
  //
  // Removing the early-return; always call getCardSales, then let
  // checkCHTrust's title-cohesion path decide trust when prices-by-card
  // is empty. Blob protection is still intact — title-cohesion at 80%+
  // hit rate on both playerSurname AND year rejects the random-recent-
  // sales blob (see checkCHTrust at ~L1520 for the rule).
  //
  // Cost: one extra CH HTTP call for cards CH truly has no data on.
  // getCardSales is cached (12h) so the incremental cost per unique
  // orphan card_id per 12h is one probe. Benefit: recover pricing on
  // thin-SKU auto/parallel cards CH does index individual sales for
  // but not daily aggregate. High-value autos with 2-5 sales/month
  // are the entire high-margin segment; missing them was a real
  // revenue-adjacent bug.
  const sales = await getCardSales(cardId, grade, 50);

  if (series.length === 0 && sales.length === 0) {
    return empty("no_real_data");
  }

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
  return isAutoCardNumber(c.number);
}

/**
 * CF-CARDID-SUGGESTER-AUTO-INFERENCE (Drew, 2026-07-14): exported so the
 * suggester's field-alignment scorer can recognize CH's autograph SKUs.
 * CH stores auto-ness in the card_number prefix (CPA-, BCPA-, CRA-, etc.),
 * NOT in the variant/title text — so a suggester that only checks text
 * fires a false "isAuto mismatch" on every real autograph pick, degrading
 * confidence tier. Reuses the same AUTO_NUMBER_PREFIXES vocabulary as
 * cardMatchesTokens / hasAutoSignal.
 */
export function isAutoCardNumber(cardNumber: string | null | undefined): boolean {
  const num = (cardNumber ?? "").toString().toLowerCase();
  if (!num) return false;
  return AUTO_PREFIX_RE.test(num);
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

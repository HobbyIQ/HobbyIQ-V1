/**
 * Cardsight API client. Phase 1 of migration per ADR-cardsight-migration-2026-05-18.
 *
 * API:   https://api.cardsight.ai/v1
 * Auth:  X-API-Key header from CARDSIGHT_API_KEY env var
 * Timeout: 20 seconds (matches Card Hedge)
 * Retry: exponential backoff (1s, 2s, 4s) on 429/500+
 *
 * Key quirks (per May 18, 2026 evaluation):
 *  - All catalog searches include segment=baseball (non-baseball excluded at API layer)
 *  - The grade= and player= filter params are silently ignored by the API
 *  - Parallel filtering via ?parallel_id= on the pricing endpoint
 */

import { cacheWrap } from "../shared/cache.service.js";

const BASE_URL = "https://api.cardsight.ai/v1";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;

// Lightweight structured logger (matches old createLogger("cardsight.client") shape).
// CF-OPS-HARDENING-1c (2026-06-04): every emitted line carries
// `subsystem: "cardsight"` so the Azure Monitor error-spike alert query can
// pivot on a single dimension regardless of source file.
const log = {
  info: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "cardsight.client", subsystem: "cardsight", ...fields })),
  warn: (event: string, fields: Record<string, unknown> = {}) =>
    console.warn(JSON.stringify({ event, source: "cardsight.client", subsystem: "cardsight", ...fields })),
  debug: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "cardsight.client", subsystem: "cardsight", level: "debug", ...fields })),
};

const CATALOG_TTL_SEC = 6 * 3600;  // 6h
const DETAIL_TTL_SEC  = 24 * 3600; // 24h
const PRICING_TTL_SEC = 6 * 3600;  // 6h
// PHASE-4A-2.2 (2026-06-02): stale-serve window. Past the fresh TTL but
// inside this window, a stale entry is returned with freshness:"stale" if
// Cardsight fails. Pricing is the load-bearing surface for Risk #2 (a
// Cardsight outage = full prediction outage without this); apply to pricing
// at minimum. Catalog/detail can opt in later if outage patterns warrant.
const PRICING_STALE_SERVE_TTL_SEC = 24 * 3600;  // 24h

// ─── Exported Types ──────────────────────────────────────────────────────────

export interface CardsightCatalogResult {
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
  numberedTo?: number;
}

export interface CardsightCardDetail {
  id: string;
  name: string;
  number: string;
  releaseName: string;
  setName: string;
  year: number;
  parallels: CardsightParallel[];
  /**
   * Free-form attribute tags from Cardsight (e.g. ["MLB-KCR", "RC"]).
   * Surfaced by the catalog detail response; empirically verified
   * 2026-05-29 (Cardsight published-SDK investigation Appendix A1).
   * Always an array — empty when the upstream response omits the field
   * or sets it to a non-array value. Optional in the interface for
   * backward-compat with consumers that don't read it; the mapper
   * below always populates `[]` when absent.
   */
  attributes?: string[];
  /** Set to true when the card was not found (404). Never throws for 404. */
  notFound?: boolean;
}

export interface CardsightSaleRecord {
  title: string;
  price: number;
  date: string | null;
  source: string;
  url: string | null;
  image_url?: string | null;
}

export interface CardsightGradedEntry {
  grade_value: string;
  count: number;
  records: CardsightSaleRecord[];
}

export interface CardsightGradedCompany {
  company_name: string;
  grades: CardsightGradedEntry[];
}

// CF-CARDSIGHT-PRICING-CARD-SCHEMA (2026-06-07): pricing endpoint's
// embedded `card` object has a DIFFERENT shape than the catalog/detail
// endpoints. Cardsight returns:
//   { card_id, name, number, set: { set_id, name, year, release } }
// — snake-case id, `name` is the player, `set` is a nested object with
// `name`/`year`/`release`. The catalog/detail shape (CardsightCatalogResult)
// uses `id`, `setName`, `releaseName`, top-level `year`, and an optional
// top-level `player`. Conflating the two types caused fetchComps to read
// fields that don't exist on the wire → null identity on EVERY pinned-id
// price call. See CF-COMP-PAGE-RECON probe results 2026-06-07.
//
// All fields optional because: (a) Cardsight has been known to omit
// fields on edge rows, and (b) the wire schema may drift again; the
// consistency guard in fetchComps catches a missing/mismatched card_id
// before the identity leaks downstream.
export interface CardsightPricingCard {
  card_id?: string;
  name?: string;
  number?: string;
  set?: {
    set_id?: string;
    name?: string;
    year?: string;
    release?: string;
  };
}

export interface CardsightPricingResponse {
  card?: CardsightPricingCard;
  raw: { count: number; records: CardsightSaleRecord[] };
  graded: CardsightGradedCompany[];
  meta: { total_records: number; last_sale_date: string | null };
  /** Set to true when the card was not found (404). Never throws for 404. */
  notFound?: boolean;
  /**
   * CF-CARDSIGHT-RESOLVER-REDESIGN: indicates whether the response came
   * from the parallel_id filter or the unified-fallback retry inside
   * _getPricing. The router's parallelTitleMatch.ts consumes this flag
   * to decide whether to apply title-matching to the unified bucket.
   * Not present on responses that weren't subject to a parallel_id query
   * (i.e. the caller didn't pass parallelId).
   */
  __parallelIdFilterFellBack?: boolean;
  /**
   * PHASE-4A-2.2 (2026-06-02): stale-serve marker. Absent or "fresh" means
   * the response was returned from a fresh fetch or a fresh-TTL cache hit.
   * "stale" means cacheWrap fell back to a stale-but-within-window entry
   * because the underlying Cardsight call failed (Risk #2 mitigation:
   * Cardsight outage → serve stale, never empty). Downstream UI can render
   * an "approximate — Cardsight unavailable" badge when this is "stale".
   */
  freshness?: "fresh" | "stale";
}

// ─── Error Types ─────────────────────────────────────────────────────────────

export class CardsightApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "CardsightApiError";
  }
}

export class CardsightTimeoutError extends Error {
  constructor(message = "Cardsight API request timed out after 20s") {
    super(message);
    this.name = "CardsightTimeoutError";
  }
}

export class CardsightNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardsightNotFoundError";
  }
}

// CF-CARDSIGHT-IDENTIFY-INTEGRATION: distinct from CardsightApiError so
// callers can map validation failures (image too small, wrong format,
// etc.) to user-facing 400 responses instead of a generic upstream 502.
// Cardsight identify returns { error, code } on 400; we surface both.
export class CardsightValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "CardsightValidationError";
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

function apiKey(): string | null {
  return process.env.CARDSIGHT_API_KEY ?? null;
}

function authHeaders(): Record<string, string> {
  const key = apiKey();
  if (!key) return {};
  return { "X-API-Key": key };
}

function cKey(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts.map((p) => String(p).toLowerCase().replace(/\s+/g, "_"))].join(":");
}

const EMPTY_PRICING: CardsightPricingResponse = {
  raw: { count: 0, records: [] },
  graded: [],
  meta: { total_records: 0, last_sale_date: null },
};

/**
 * Fetch with exponential backoff retry on 429/500+.
 * Throws CardsightTimeoutError on timeout, CardsightApiError on 4xx/5xx after max retries.
 */
const DEFAULT_NON_THROW_STATUSES: ReadonlySet<number> = new Set([404]);

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  attempt = 0,
  nonThrowStatuses: ReadonlySet<number> = DEFAULT_NON_THROW_STATUSES,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        ...((options.headers as Record<string, string>) ?? {}),
        ...authHeaders(),
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      log.warn("timeout", {
        endpoint: "fetchWithRetry",
        url,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        attempt,
      });
      throw new CardsightTimeoutError();
    }
    throw err;
  }

  if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
    const backoffMs = Math.pow(2, attempt) * 1000;
    log.warn("retry", {
      endpoint: "fetchWithRetry",
      url,
      status: res.status,
      attempt: attempt + 1,
      backoffMs,
    });
    await new Promise<void>((r) => setTimeout(r, backoffMs));
    return fetchWithRetry(url, options, attempt + 1, nonThrowStatuses);
  }

  if (!res.ok && !nonThrowStatuses.has(res.status)) {
    const requestId = res.headers?.get?.("x-request-id") ?? null;
    throw new CardsightApiError(
      `Cardsight API error: ${res.status}`,
      res.status,
      requestId,
    );
  }

  return res;
}

// ─── Exported Functions ───────────────────────────────────────────────────────

/**
 * Search Cardsight catalog for cards.
 * Always includes segment=baseball — non-baseball cards excluded at the API layer.
 * Returns [] when CARDSIGHT_API_KEY is missing, on HTTP errors, or on network failure.
 */
export async function searchCatalog(
  query: string,
  opts: { year?: string | number; take?: number } = {},
): Promise<CardsightCatalogResult[]> {
  if (!apiKey()) {
    log.warn("api_key_missing", { endpoint: "searchCatalog", query });
    return [];
  }
  const take = opts.take ?? 20;
  return cacheWrap(
    cKey("cs:catalog", query, String(opts.year ?? ""), String(take)),
    () => _searchCatalog(query, opts),
    CATALOG_TTL_SEC,
  );
}

async function _searchCatalog(
  query: string,
  opts: { year?: string | number; take?: number },
): Promise<CardsightCatalogResult[]> {
  try {
    const params = new URLSearchParams({
      q: query,
      type: "card",
      segment: "baseball",
      take: String(opts.take ?? 20),
    });
    if (opts.year != null) params.set("year", String(opts.year));
    const res = await fetchWithRetry(`${BASE_URL}/catalog/search?${params}`);
    if (!res.ok) {
      log.warn("api_http_error", {
        status: res.status,
        query,
        endpoint: "searchCatalog",
      });
      return [];
    }
    const body: any = await res.json();
    return Array.isArray(body?.results) ? (body.results as CardsightCatalogResult[]) : [];
  } catch (err: any) {
    if (err instanceof CardsightTimeoutError) throw err;
    log.warn("api_threw", {
      query,
      endpoint: "searchCatalog",
      error: err?.message ?? String(err),
    });
    return [];
  }
}

/**
 * Get full card detail including parallels[].
 * Returns { notFound: true } sentinel on 404 — never throws for 404.
 */
export async function getCardDetail(cardId: string): Promise<CardsightCardDetail> {
  if (!apiKey()) {
    log.warn("api_key_missing", { endpoint: "getCardDetail", card_id: cardId });
    return _notFoundDetail(cardId);
  }
  return cacheWrap(
    cKey("cs:detail", cardId),
    () => _getCardDetail(cardId),
    DETAIL_TTL_SEC,
  );
}

function _notFoundDetail(cardId: string): CardsightCardDetail {
  return {
    id: cardId,
    name: "",
    number: "",
    releaseName: "",
    setName: "",
    year: 0,
    parallels: [],
    attributes: [],
    notFound: true,
  };
}

async function _getCardDetail(cardId: string): Promise<CardsightCardDetail> {
  try {
    const res = await fetchWithRetry(
      `${BASE_URL}/catalog/cards/${encodeURIComponent(cardId)}`,
    );
    if (res.status === 404) return _notFoundDetail(cardId);
    if (!res.ok) {
      log.warn("api_http_error", {
        status: res.status,
        card_id: cardId,
        endpoint: "getCardDetail",
      });
      return _notFoundDetail(cardId);
    }
    const body: any = await res.json();
    // Cardsight returns the year as `releaseYear` (string, e.g. "2018"), NOT
    // `year`. Bug existed in this mapper since the Cardsight migration but
    // was dormant — no caller consumed detail.year until CF-CARDSIGHT-
    // CARDIDENTITY-COMPLETENESS (investigation: a6c6dd9). Coerce to number
    // so the interface contract (year: number) holds.
    const rawYear = body.releaseYear ?? body.year ?? null;
    const year = rawYear != null && Number.isFinite(Number(rawYear))
      ? Number(rawYear)
      : 0;
    return {
      id: body.id ?? cardId,
      name: body.name ?? "",
      number: body.number ?? "",
      releaseName: body.releaseName ?? "",
      setName: body.setName ?? "",
      year,
      parallels: Array.isArray(body.parallels) ? (body.parallels as CardsightParallel[]) : [],
      attributes: Array.isArray(body.attributes)
        ? (body.attributes.filter((a: unknown): a is string => typeof a === "string"))
        : [],
    };
  } catch (err: any) {
    if (err instanceof CardsightTimeoutError) throw err;
    log.warn("api_threw", {
      card_id: cardId,
      endpoint: "getCardDetail",
      error: err?.message ?? String(err),
    });
    return _notFoundDetail(cardId);
  }
}

/**
 * CF-CARD-IMAGE-PROXY (2026-06-08): fetch the catalog-asset card image
 * for a given Cardsight cardId. Returns the raw JPEG bytes + content
 * type when the endpoint serves the card; `notFound: true` sentinel
 * when Cardsight returns 404 (parallel ids share the base card image
 * and aren't served directly — caller should use the base cardId).
 *
 * Endpoint contract (verified 2026-06-08):
 *   GET /v1/images/cards/<cardId>
 *   - Auth: X-API-Key required (401 without)
 *   - 200: image/jpeg binary (Cache-Control: public, max-age=86400)
 *   - 404: tiny JSON {"error":"Resource not found","code":"NOT_FOUND"}
 *   - ?size= and ?format= are ignored / rejected respectively
 */
export interface CardsightImageResponse {
  bytes: Buffer;
  contentType: string;
  /** Set when the upstream returned 404. */
  notFound?: boolean;
}

export async function getCardImage(cardId: string): Promise<CardsightImageResponse> {
  if (!apiKey()) {
    log.warn("api_key_missing", { endpoint: "getCardImage", card_id: cardId });
    return { bytes: Buffer.alloc(0), contentType: "application/json", notFound: true };
  }
  try {
    const res = await fetchWithRetry(
      `${BASE_URL}/images/cards/${encodeURIComponent(cardId)}`,
    );
    if (res.status === 404) {
      return { bytes: Buffer.alloc(0), contentType: "application/json", notFound: true };
    }
    if (!res.ok) {
      log.warn("api_http_error", {
        status: res.status,
        card_id: cardId,
        endpoint: "getCardImage",
      });
      return { bytes: Buffer.alloc(0), contentType: "application/json", notFound: true };
    }
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const ab = await res.arrayBuffer();
    return { bytes: Buffer.from(ab), contentType };
  } catch (err: any) {
    if (err instanceof CardsightTimeoutError) throw err;
    log.warn("api_threw", {
      card_id: cardId,
      endpoint: "getCardImage",
      error: err?.message ?? String(err),
    });
    return { bytes: Buffer.alloc(0), contentType: "application/json", notFound: true };
  }
}

/**
 * Fetch pricing data (raw + graded sales) for a card.
 * Optionally scoped to a specific parallel via parallelId.
 * Returns { notFound: true } sentinel on 404 — never throws for 404.
 */
export async function getPricing(
  cardId: string,
  opts: { parallelId?: string } = {},
): Promise<CardsightPricingResponse> {
  if (!apiKey()) {
    log.warn("api_key_missing", {
      endpoint: "getPricing",
      card_id: cardId,
      parallel_id: opts.parallelId ?? null,
    });
    return { ...EMPTY_PRICING, notFound: true };
  }
  return cacheWrap(
    cKey("cs:pricing", cardId, opts.parallelId ?? ""),
    () => _getPricing(cardId, opts),
    {
      freshTtlSeconds: PRICING_TTL_SEC,
      staleServeTtlSeconds: PRICING_STALE_SERVE_TTL_SEC,
    },
  );
}

async function _getPricing(
  cardId: string,
  opts: { parallelId?: string },
): Promise<CardsightPricingResponse> {
  // First-pass: try the call with the parallel_id filter when provided.
  const firstPass = await _getPricingRaw(cardId, opts.parallelId ?? null);

  // CF-CARDSIGHT-RESOLVER-COMPREHENSIVE (parallel_id fallback): empirical
  // probing during the 2026-05-27 incident showed Cardsight's pricing
  // endpoint returns ZERO records when filtered by parallel_id for at
  // least the Maddux Tiffany case (parallel_id=516f7c55... → 0 raw, 0
  // graded). The unified call (no parallel_id) returns 156 raw + 59
  // PSA 10 records. Cardsight does NOT appear to actually tag eBay sales
  // by parallelId — the parallels[] sub-array is catalog metadata only,
  // not a filterable comp dimension. Filing this empirical finding
  // forward; resolver redesign (tomorrow's CF) will decide whether to
  // continue passing parallel_id at all.
  //
  // Fallback semantic: if parallel_id was used AND the response carried
  // zero comps (raw count 0 AND graded array empty/zero records), retry
  // the call WITHOUT parallel_id. Preserves the no-parallel-filter
  // behavior the resolver had before parallel resolution succeeded.
  // Resolver still binds to the right cardId; comp pool just falls back
  // to unified (base + all parallels) when parallel filtering yields
  // empty.
  if (opts.parallelId) {
    const firstPassEmpty =
      (firstPass.raw?.count ?? 0) === 0 &&
      (firstPass.graded?.length ?? 0) === 0;
    if (firstPassEmpty && !firstPass.notFound) {
      log.info("pricing_parallel_filter_empty_fallback", {
        card_id: cardId,
        parallel_id: opts.parallelId,
        endpoint: "getPricing",
      });
      const unified = await _getPricingRaw(cardId, null);
      // CF-CARDSIGHT-RESOLVER-REDESIGN: tag the response so the router
      // can decide whether to apply title-matching to the unified bucket.
      unified.__parallelIdFilterFellBack = true;
      return unified;
    }
  }

  return firstPass;
}

async function _getPricingRaw(
  cardId: string,
  parallelId: string | null,
): Promise<CardsightPricingResponse> {
  // CF-OPS-HARDENING-1a (2026-06-04): every LIVE getPricing call against
  // Cardsight increments the budget counter. Cache hits never reach here
  // (cacheWrap short-circuits in getPricing()), so this counts exactly
  // the calls that draw from the 100k/mo quota. The parallel-fallback
  // path in _getPricing() invokes _getPricingRaw a second time on its
  // own — that second HTTP call counts separately, which is correct
  // (Cardsight bills it separately).
  incrementGetPricingLiveCall();
  try {
    const params = new URLSearchParams();
    if (parallelId) params.set("parallel_id", parallelId);
    const qs = params.toString();
    const url = `${BASE_URL}/pricing/${encodeURIComponent(cardId)}${qs ? `?${qs}` : ""}`;
    const res = await fetchWithRetry(url);
    if (res.status === 404) return { ...EMPTY_PRICING, notFound: true };
    if (!res.ok) {
      log.warn("api_http_error", {
        status: res.status,
        card_id: cardId,
        endpoint: "getPricing",
        parallel_id: parallelId,
      });
      return { ...EMPTY_PRICING };
    }
    const body: any = await res.json();
    return {
      card: body.card,
      raw: body.raw ?? { count: 0, records: [] },
      graded: Array.isArray(body.graded) ? (body.graded as CardsightGradedCompany[]) : [],
      meta: body.meta ?? { total_records: 0, last_sale_date: null },
    };
  } catch (err: any) {
    if (err instanceof CardsightTimeoutError) throw err;
    log.warn("api_threw", {
      card_id: cardId,
      endpoint: "getPricing",
      parallel_id: parallelId,
      error: err?.message ?? String(err),
    });
    return { ...EMPTY_PRICING };
  }
}

// ─── CF-CARDSIGHT-IDENTIFY-INTEGRATION ───────────────────────────────────────
//
// Wraps Cardsight's POST /v1/identify/card image-identification endpoint.
// Empirical contract per pre-Phase-2 probe (4 calls, 2026-05-30):
//
//   Input shape: multipart/form-data with field name "image" (also accepts
//                "file" field name or raw body w/ Content-Type: image/jpeg;
//                we pick the "image" multipart convention as canonical).
//   Min dimension: 100px on any side (Cardsight returns 400 + VALIDATION_ERROR
//                  otherwise).
//   200 response shape (regardless of success: true/false):
//     {
//       success: boolean,         // false when no card detected or image
//                                 // quality insufficient -- NOT an error!
//       requestId: string,
//       processingTime: number,   // ms
//       detections?: [...],       // present when success:true with finds
//       messages?: [{type, message}]  // info/warnings (image quality, etc)
//     }
//   400 response shape:
//     { error: string, code: "VALIDATION_ERROR" }
//   Rate limit: 8 req/s shared with catalog endpoints (per-key global bucket)
//
// Decision lock from Phase 1: use fetch pattern (NOT cardsightai SDK) for
// 100% codebase consistency with existing Cardsight surfaces.

export interface CardsightIdentifyParallel {
  id: string;
  name: string;
  numberedTo?: number | null;
}

export interface CardsightIdentifyCard {
  id: string;
  segmentId?: string;
  releaseId?: string;
  setId?: string;
  year?: string;
  manufacturer?: string;
  releaseName?: string;
  setName?: string;
  name?: string;
  number?: string;
  parallel?: CardsightIdentifyParallel;
}

export interface CardsightIdentifyGradeValue {
  id?: string;
  value: string;
  condition: string;
}

export interface CardsightIdentifyGradeCompany {
  id?: string;
  name: string;
}

export interface CardsightIdentifyQualifier {
  id?: string;
  code: string;
}

export interface CardsightIdentifyGrading {
  confidence: string;
  company: CardsightIdentifyGradeCompany;
  grade?: CardsightIdentifyGradeValue;
  qualifier?: CardsightIdentifyQualifier;
  autoGrade?: CardsightIdentifyGradeValue;
}

export interface CardsightIdentifyDetection {
  confidence: string;
  card: CardsightIdentifyCard;
  grading?: CardsightIdentifyGrading;
}

export interface CardsightIdentifyMessage {
  type: string;
  message: string;
}

export interface CardsightIdentifyResponse {
  success: boolean;
  requestId: string;
  processingTime: number;
  detections?: CardsightIdentifyDetection[];
  messages?: CardsightIdentifyMessage[];
}

interface CardsightIdentifyValidationBody {
  error: string;
  code: string;
}

/**
 * Submit an image to Cardsight's identify endpoint.
 *
 * Returns the response body verbatim regardless of `success: true/false` --
 * the caller decides UX based on the shape. Cardsight's `success: false`
 * indicates "no card detected" or "image quality insufficient", which is
 * a normal API outcome NOT an error.
 *
 * Throws:
 *   - CardsightValidationError on 400 (image dimensions too small, wrong
 *     format, etc.) -- callers map to user-facing 400 with the message
 *   - CardsightTimeoutError on timeout after 20s
 *   - CardsightApiError on persistent 429/5xx after 3-retry exponential
 *     backoff
 *
 * Does NOT cache (each image is unique). Caching the response would be
 * semantically wrong and would consume cache space without benefit.
 */
export async function identify(
  imageBuffer: Buffer | Uint8Array,
  filename = "image.jpg",
  mimeType = "image/jpeg",
): Promise<CardsightIdentifyResponse> {
  if (!apiKey()) {
    throw new CardsightApiError(
      "CARDSIGHT_API_KEY not set in env",
      0,
      null,
    );
  }

  const start = Date.now();
  log.info("identify_start", {
    endpoint: "identify",
    filename,
    mime_type: mimeType,
    bytes: imageBuffer.byteLength,
  });

  const form = new FormData();
  // Cast required: TS DOM lib's BlobPart expects strict ArrayBuffer, but
  // Node's Buffer typedef uses ArrayBufferLike (includes SharedArrayBuffer).
  // Runtime contract is fine; the cast acknowledges the type-system friction.
  form.append(
    "image",
    new Blob([imageBuffer as unknown as BlobPart], { type: mimeType }),
    filename,
  );

  // 400 (validation) intercepted below; everything else uses default
  // retry/throw behavior (timeout, 429+5xx retry, other 4xx throws ApiError).
  const res = await fetchWithRetry(
    `${BASE_URL}/identify/card`,
    {
      method: "POST",
      body: form,
      headers: { Accept: "application/json" },
    },
    0,
    new Set([400, 404]),
  );

  const requestId = res.headers.get("x-request-id");
  const rateLimitRemaining = res.headers.get("x-ratelimit-remaining");

  if (res.status === 400) {
    let body: CardsightIdentifyValidationBody;
    try {
      body = (await res.json()) as CardsightIdentifyValidationBody;
    } catch {
      throw new CardsightValidationError(
        "Cardsight returned 400 with unparseable body",
        "PARSE_ERROR",
        requestId,
      );
    }
    log.warn("identify_validation_error", {
      endpoint: "identify",
      code: body.code,
      error: body.error,
      request_id: requestId,
      rate_limit_remaining: rateLimitRemaining,
      elapsed_ms: Date.now() - start,
    });
    throw new CardsightValidationError(body.error, body.code, requestId);
  }

  const body = (await res.json()) as CardsightIdentifyResponse;
  log.info("identify_end", {
    endpoint: "identify",
    request_id: body.requestId ?? requestId,
    processing_time_ms: body.processingTime,
    success: body.success,
    detection_count: body.detections?.length ?? 0,
    message_count: body.messages?.length ?? 0,
    rate_limit_remaining: rateLimitRemaining,
    elapsed_ms: Date.now() - start,
  });
  return body;
}

// ─── CF-SCANNING-B5 (2026-06-03): identifiable-set inventory endpoints ──────
//
// Two read-only endpoints used by the B5b daily refresh job (paginates
// list/sets into a Cosmos snapshot) and the B5a pre-flight live-fallback
// (when the snapshot doesn't have the set yet). Both use the same
// fetchWithRetry / authHeaders / timeout/error model as identify/getPricing.
//
// Endpoint shapes verified empirically 2026-05-29 against the live API:
//   GET /v1/identify/list/sets?skip=0&take=50
//     { sets: [{year, release_name, segment_name, set_name, set_id}],
//       total_count, skip, take }
//   GET /v1/identify/check/set/{setId}
//     { set_id, is_identifiable: boolean }
// Pagination cap empirically observed: take > 50 returns HTTP 400.

export interface CardsightIdentifiableSet {
  year: string;
  release_name: string;
  segment_name: string;
  set_name: string;
  set_id: string;
}

export interface CardsightIdentifiableSetsPage {
  sets: CardsightIdentifiableSet[];
  total_count: number;
  skip: number;
  take: number;
}

export interface CardsightSetSupportedResponse {
  set_id: string;
  is_identifiable: boolean;
}

/**
 * GET /v1/identify/list/sets — one page of the identify-capable set
 * inventory. Throws CardsightApiError on non-2xx, CardsightTimeoutError on
 * timeout. Empty result returned as { sets: [], total_count: 0 ... } when
 * the API key is missing (consistent with searchCatalog's null-key
 * behavior).
 */
export async function listIdentifiableSets(
  opts: { skip?: number; take?: number } = {},
): Promise<CardsightIdentifiableSetsPage> {
  const empty: CardsightIdentifiableSetsPage = {
    sets: [],
    total_count: 0,
    skip: opts.skip ?? 0,
    take: opts.take ?? 50,
  };
  if (!apiKey()) {
    log.warn("api_key_missing", { endpoint: "listIdentifiableSets" });
    return empty;
  }
  const skip = opts.skip ?? 0;
  const take = opts.take ?? 50;
  const url = `${BASE_URL}/identify/list/sets?skip=${skip}&take=${take}`;
  const start = Date.now();
  const res = await fetchWithRetry(url);
  const body = (await res.json()) as Partial<CardsightIdentifiableSetsPage>;
  log.info("identifiable_sets_page", {
    endpoint: "listIdentifiableSets",
    skip,
    take,
    returned: body.sets?.length ?? 0,
    total_count: body.total_count ?? 0,
    elapsed_ms: Date.now() - start,
  });
  return {
    sets: Array.isArray(body.sets) ? body.sets : [],
    total_count: typeof body.total_count === "number" ? body.total_count : 0,
    skip: typeof body.skip === "number" ? body.skip : skip,
    take: typeof body.take === "number" ? body.take : take,
  };
}

/**
 * GET /v1/identify/check/set/{setId} — live pre-flight check used as the
 * cache-miss fallback. Throws CardsightApiError on non-2xx. Returns null
 * when the API key is missing — caller treats null as "unknown, deny by
 * default" so a misconfigured backend doesn't falsely advertise support.
 */
export async function checkSetIdentifiable(
  setId: string,
): Promise<CardsightSetSupportedResponse | null> {
  if (!apiKey()) {
    log.warn("api_key_missing", { endpoint: "checkSetIdentifiable", set_id: setId });
    return null;
  }
  const safe = encodeURIComponent(setId);
  const url = `${BASE_URL}/identify/check/set/${safe}`;
  const start = Date.now();
  const res = await fetchWithRetry(url);
  const body = (await res.json()) as Partial<CardsightSetSupportedResponse>;
  log.info("check_set_identifiable", {
    endpoint: "checkSetIdentifiable",
    set_id: setId,
    is_identifiable: body.is_identifiable === true,
    elapsed_ms: Date.now() - start,
  });
  return {
    set_id: typeof body.set_id === "string" ? body.set_id : setId,
    is_identifiable: body.is_identifiable === true,
  };
}

// ─── CF-OPS-HARDENING-1a: getPricing budget tracker ─────────────────────────
//
// Cardsight's pricing endpoint sits behind a 100k/mo soft quota. Budget
// alerts need accurate month-to-date totals, so we count only LIVE calls
// (cache hits never reach _getPricingRaw).
//
// Choice: hourly-delta structured log emit (NOT per-call traces, NOT App
// Insights customMetric). Why:
//
//   - Per-call traces are subject to App Insights ingestion sampling at
//     elevated volumes; cumulative MTD sums become unreliable, which is
//     unacceptable for a budget signal.
//   - One structured log line per instance per hour sits far below any
//     sampling threshold and reliably ingests. The Azure Monitor alert
//     query SUMs `live_calls` across all hourly emits across all
//     instances for the current month.
//   - Restart loss is bounded to one hour of one instance's traffic;
//     budget thresholds (75/90/100%) tolerate this — at worst the alert
//     fires one hour later than reality.
//   - customMetric was considered but is SDK-config-dependent and harder
//     to verify sampling-off than a single log line that matches the
//     established `compiq_cache_hit_rate` precedent.

const _getPricingBudget = {
  liveCalls: 0,
  timer: null as NodeJS.Timeout | null,
};

function incrementGetPricingLiveCall(): void {
  _getPricingBudget.liveCalls += 1;
}

function currentBudgetMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function emitGetPricingBudgetHourly(): void {
  const live = _getPricingBudget.liveCalls;
  _getPricingBudget.liveCalls = 0;
  console.log(JSON.stringify({
    event: "cardsight_getpricing_budget",
    source: "cardsight.client",
    intervalSec: 3600,
    month: currentBudgetMonth(),
    live_calls: live,
    instance: process.env.WEBSITE_INSTANCE_ID ?? "local",
  }));
}

export function startGetPricingBudgetEmit(): void {
  if (process.env.GETPRICING_BUDGET_EMIT_DISABLED === "true") {
    console.log("[cardsight] getPricing budget emit disabled via GETPRICING_BUDGET_EMIT_DISABLED");
    return;
  }
  if (_getPricingBudget.timer) return;
  _getPricingBudget.timer = setInterval(emitGetPricingBudgetHourly, 60 * 60 * 1000);
  console.log("[cardsight] getPricing budget emit scheduled hourly");
}

export function stopGetPricingBudgetEmit(): void {
  if (_getPricingBudget.timer) {
    clearInterval(_getPricingBudget.timer);
    _getPricingBudget.timer = null;
  }
}

// Test-only accessors so unit tests can assert counter behavior without
// waiting for the hourly emit.
export function __getPricingLiveCallCountForTests(): number {
  return _getPricingBudget.liveCalls;
}
export function __resetGetPricingBudgetForTests(): void {
  _getPricingBudget.liveCalls = 0;
  if (_getPricingBudget.timer) {
    clearInterval(_getPricingBudget.timer);
    _getPricingBudget.timer = null;
  }
}
export function __emitGetPricingBudgetForTests(): void {
  emitGetPricingBudgetHourly();
}

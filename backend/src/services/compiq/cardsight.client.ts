/**
 * Cardsight API client. Phase 1 of migration per ADR-cardsight-migration-2026-05-18.
 * NOT YET INTEGRATED with compiqEstimate.service.ts.
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
import { createLogger } from "../../lib/logger.js";

const BASE_URL = "https://api.cardsight.ai/v1";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;
const log = createLogger("cardsight.client");

const CATALOG_TTL_SEC = 6 * 3600;  // 6h
const DETAIL_TTL_SEC  = 24 * 3600; // 24h
const PRICING_TTL_SEC = 6 * 3600;  // 6h

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

export interface CardsightPricingResponse {
  card?: CardsightCatalogResult;
  raw: { count: number; records: CardsightSaleRecord[] };
  graded: CardsightGradedCompany[];
  meta: { total_records: number; last_sale_date: string | null };
  /** Set to true when the card was not found (404). Never throws for 404. */
  notFound?: boolean;
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
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  attempt = 0,
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
    return fetchWithRetry(url, options, attempt + 1);
  }

  if (!res.ok && res.status !== 404) {
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
    return {
      id: body.id ?? cardId,
      name: body.name ?? "",
      number: body.number ?? "",
      releaseName: body.releaseName ?? "",
      setName: body.setName ?? "",
      year: body.year ?? 0,
      parallels: Array.isArray(body.parallels) ? (body.parallels as CardsightParallel[]) : [],
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
    PRICING_TTL_SEC,
  );
}

async function _getPricing(
  cardId: string,
  opts: { parallelId?: string },
): Promise<CardsightPricingResponse> {
  try {
    const params = new URLSearchParams();
    if (opts.parallelId) params.set("parallel_id", opts.parallelId);
    const qs = params.toString();
    const url = `${BASE_URL}/pricing/${encodeURIComponent(cardId)}${qs ? `?${qs}` : ""}`;
    const res = await fetchWithRetry(url);
    if (res.status === 404) return { ...EMPTY_PRICING, notFound: true };
    if (!res.ok) {
      log.warn("api_http_error", {
        status: res.status,
        card_id: cardId,
        endpoint: "getPricing",
        parallel_id: opts.parallelId ?? null,
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
      parallel_id: opts.parallelId ?? null,
      error: err?.message ?? String(err),
    });
    return { ...EMPTY_PRICING };
  }
}

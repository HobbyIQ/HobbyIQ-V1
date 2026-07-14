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

const BASE_URL = "https://api.cardsight.ai/v1";
const DEFAULT_TIMEOUT_MS = 8_000;

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

  const params = new URLSearchParams({
    q,
    type: "card",
    segment: "baseball",
    take: String(opts.take ?? 10),
  });
  if (opts.year !== undefined) params.set("year", String(opts.year));

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

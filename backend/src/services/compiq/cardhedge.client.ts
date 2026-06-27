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
const PRICES_BY_CARD_TTL_SEC = 4 * 3600;  // daily series — 4h
const BASE_SIBLING_TTL_SEC = 24 * 3600;   // card_id mapping — 24h (very stable)

// CF-TREND-ADJUSTED-PRICING: hard cap on momentum scaling. Base-card movement
// above ±200% per 30 days is treated as a spike, not signal — capped to
// 3.0× (or 1/3×) before the cap window scales with days-since-comp.
const MAX_MOMENTUM_PER_30D = 3.0;

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

/** Daily closing price for a card_id from /v1/cards/prices-by-card. */
export interface DailyPrice {
  closing_date: string;  // ISO date, slice(0,10)
  price: number;
}

/**
 * Trend-adjusted price for a thin-comp parallel card.
 *
 * Fired when a target parallel has 1-2 sales in the comp window but the BASE
 * card of the same player/year/product has dense daily price data. The most
 * recent parallel sale is treated as the anchor; the base card's momentum
 * since that sale date is applied to extrapolate forward.
 *
 * Momentum is hard-capped per MAX_MOMENTUM_PER_30D before the cap window
 * scales with days-since-comp. Confidence band widens to ±15% when momentum
 * exceeds 1.2× or drops below 0.8×; ±8% otherwise.
 */
export interface TrendAdjustment {
  rawCompPrice: number;          // The most-recent parallel sale price (anchor)
  rawCompDate: string;           // The date of that sale (ISO YYYY-MM-DD)
  trendAdjustedPrice: number;    // rawCompPrice * cappedMomentum
  momentum: number;              // basePriceToday / basePriceAtCompDate (capped)
  momentumWasCapped: boolean;    // true if raw momentum exceeded the cap
  basePriceAtCompDate: number;   // base card's closing price on the anchor date
  basePriceToday: number;        // base card's most recent closing price
  baseCardId: string;            // CH card_id of the base sibling used
  daysSinceComp: number;         // integer days between rawCompDate and series last
  confidenceBandLow: number;     // trendAdjustedPrice * (1 - band)
  confidenceBandHigh: number;    // trendAdjustedPrice * (1 + band)
}

/** POST /cards/card-search — free-text card lookup (Baseball). */
export async function searchCards(query: string, limit = 10): Promise<CardHedgeCard[]> {
  const h = headers();
  if (!h) {
    console.warn("[cardhedge.client] CARD_HEDGE_API_KEY missing");
    return [];
  }
  return cacheWrap(cacheKey("ch:search", query, String(limit)), async () => _searchCards(query, limit, h), SEARCH_TTL_SEC);
}

async function _searchCards(query: string, limit: number, h: Record<string, string>): Promise<CardHedgeCard[]> {
  try {
    const res = await fetch(`${BASE_URL}/cards/card-search`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        search: query,
        category: "Baseball",
        page: 1,
        page_size: Math.max(1, Math.min(limit, 50)),
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[cardhedge.client] search HTTP ${res.status} for "${query}"`);
      return [];
    }
    const body: any = await res.json();
    const cards: CardHedgeCard[] = Array.isArray(body?.cards) ? body.cards : [];
    return cards.slice(0, limit);
  } catch (err: any) {
    console.warn(`[cardhedge.client] search threw for "${query}":`, err?.message ?? err);
    return [];
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

/**
 * POST /cards/prices-by-card — daily closing-price time series for a card_id.
 *
 * Returns an array of { closing_date, price } sorted ascending by date.
 * Empty array on auth failure, missing key, network error, or no data.
 * Cached 4h. Consumed by the trend-adjustment path.
 */
export async function getPricesByCard(
  cardId: string,
  grade: string = "Raw",
  days: number = 30,
): Promise<DailyPrice[]> {
  const h = headers();
  if (!h || !cardId) return [];
  return cacheWrap(
    cacheKey("ch:prices-by-card", cardId, grade, String(days)),
    async () => _getPricesByCard(cardId, grade, days, h),
    PRICES_BY_CARD_TTL_SEC,
  );
}

async function _getPricesByCard(
  cardId: string,
  grade: string,
  days: number,
  h: Record<string, string>,
): Promise<DailyPrice[]> {
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
  /**
   * CF-TREND-ADJUSTED-PRICING: time-adjusted price for thin-comp parallels.
   * Populated when the resolved card is a non-base parallel with 1-2 sales
   * AND the base sibling card has dense daily price data. null otherwise
   * (base cards, dense parallels with 3+ comps, no base sibling found,
   * thin base series). Opportunistic — internal failures return null.
   * See computeTrendAdjustment() for the algorithm.
   */
  trendAdjustment: TrendAdjustment | null;
}> {
  const grade = opts.grade ?? "Raw";
  const limit = opts.limit ?? 20;
  if (!query?.trim()) {
    return { card: null, sales: [], variantWarning: [], aiCategory: null, trendAdjustment: null };
  }

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

  if (!card?.card_id) {
    return { card: null, sales: [], variantWarning: [], aiCategory, trendAdjustment: null };
  }
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

  // CF-TREND-ADJUSTED-PRICING: opportunistic time-adjustment for thin parallels.
  // Always-on (per design). Returns null on base cards, dense parallels (3+
  // sales), missing base sibling, thin base series, or any internal failure.
  const trendAdjustment = await computeTrendAdjustment(card, sales);

  return { card, sales, variantWarning, aiCategory, trendAdjustment };
}

// ---------------------------------------------------------------------------
// CF-TREND-ADJUSTED-PRICING — trend-adjusted parallel pricing
// ---------------------------------------------------------------------------

/**
 * Find the BASE variant card_id for the same player/year/product/number.
 *
 * Used by the trend-adjustment path to anchor parallel-card momentum to its
 * base sibling's denser daily series. Cached 24h — card_id mappings are
 * stable. Returns null when no Base variant exists in CH for the sibling
 * (some sets have no base entry, or the parallel card lacks the identity
 * fields needed for a sibling search).
 */
async function findBaseCardSibling(card: CardHedgeCard): Promise<CardHedgeCard | null> {
  if (!card?.player || !card?.set || !card?.number) return null;
  const cacheK = cacheKey(
    "ch:base-sibling",
    String(card.player),
    String(card.year ?? ""),
    String(card.set),
    String(card.number),
  );
  const raw = await cacheWrap(
    cacheK,
    async () => {
      const query = [card.year, card.set, card.player].filter(Boolean).join(" ");
      const hits = await searchCards(query, 50);
      const targetNumber = String(card.number).toUpperCase();
      const match = hits.find(
        (h) =>
          (h.number ?? "").toString().toUpperCase() === targetNumber &&
          (h.variant ?? "").toLowerCase() === "base",
      );
      return match ? JSON.stringify(match) : "";
    },
    BASE_SIBLING_TTL_SEC,
  );
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CardHedgeCard;
  } catch {
    return null;
  }
}

/** Find the closest-dated closing price to a target date in a sorted series. */
function findClosestPrice(series: DailyPrice[], targetDate: string): number | null {
  if (!series.length || !targetDate) return null;
  const exact = series.find((p) => p.closing_date === targetDate);
  if (exact) return exact.price;
  const target = new Date(targetDate).getTime();
  if (!Number.isFinite(target)) return null;
  let bestDiff = Infinity;
  let bestPrice: number | null = null;
  for (const p of series) {
    const d = new Date(p.closing_date).getTime();
    if (!Number.isFinite(d)) continue;
    const diff = Math.abs(d - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestPrice = p.price;
    }
  }
  return bestPrice;
}

function daysBetween(d1: string, d2: string): number {
  const t1 = new Date(d1).getTime();
  const t2 = new Date(d2).getTime();
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 0;
  return Math.round(Math.abs(t2 - t1) / (1000 * 60 * 60 * 24));
}

/**
 * Apply the magnitude cap. The cap scales with days-since-comp: a 6-day-old
 * comp is capped at 3.0^(6/30) ≈ 1.245× momentum; a 30-day-old comp is
 * capped at the full 3.0×. Below MAX_MOMENTUM_PER_30D the raw momentum
 * passes through untouched.
 */
function capMomentum(
  momentum: number,
  daysSinceComp: number,
): { capped: number; wasCapped: boolean } {
  const cap = Math.pow(MAX_MOMENTUM_PER_30D, Math.max(daysSinceComp, 1) / 30);
  const lo = 1 / cap;
  if (momentum > cap) return { capped: cap, wasCapped: true };
  if (momentum < lo) return { capped: lo, wasCapped: true };
  return { capped: momentum, wasCapped: false };
}

/**
 * Compute trend-adjusted price for a target parallel card.
 *
 * Returns null when:
 *   - parallel card or sales are missing
 *   - parallel has 0 or 3+ sales (use direct comp instead)
 *   - parallelCard is itself the Base variant (it IS the anchor)
 *   - base sibling cannot be resolved in CH
 *   - base sibling has <7 daily price points (insufficient signal)
 *   - the most recent parallel sale lacks a usable date or price
 *
 * Otherwise returns the full TrendAdjustment payload with capped momentum
 * and a confidence band (±15% if |momentum-1| > 0.2; ±8% otherwise).
 *
 * Opportunistic: any internal failure returns null. Never throws.
 */
export async function computeTrendAdjustment(
  parallelCard: CardHedgeCard | null,
  parallelSales: CardHedgeSale[],
): Promise<TrendAdjustment | null> {
  if (!parallelCard?.card_id) return null;
  if (parallelSales.length === 0 || parallelSales.length >= 3) return null;
  if ((parallelCard.variant ?? "").toLowerCase() === "base") return null;

  try {
    const baseCard = await findBaseCardSibling(parallelCard);
    if (!baseCard?.card_id || baseCard.card_id === parallelCard.card_id) return null;

    const baseSeries = await getPricesByCard(baseCard.card_id, "Raw", 30);
    if (baseSeries.length < 7) return null;

    const sorted = parallelSales
      .filter((s) => s.date && s.price > 0)
      .slice()
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    if (!sorted.length) return null;
    const recent = sorted[0];
    const compDate = (recent.date ?? "").slice(0, 10);
    if (!compDate) return null;

    const basePriceAtComp = findClosestPrice(baseSeries, compDate);
    const basePriceToday = baseSeries[baseSeries.length - 1].price;
    if (!basePriceAtComp || !basePriceToday) return null;

    const seriesLastDate = baseSeries[baseSeries.length - 1].closing_date;
    const daysSinceComp = daysBetween(compDate, seriesLastDate);

    const rawMomentum = basePriceToday / basePriceAtComp;
    const { capped: momentum, wasCapped } = capMomentum(rawMomentum, daysSinceComp);

    const trendAdjustedPrice = recent.price * momentum;
    const bandPct = momentum > 1.2 || momentum < 0.8 ? 0.15 : 0.08;

    return {
      rawCompPrice: recent.price,
      rawCompDate: compDate,
      trendAdjustedPrice: Math.round(trendAdjustedPrice * 100) / 100,
      momentum: Math.round(momentum * 1000) / 1000,
      momentumWasCapped: wasCapped,
      basePriceAtCompDate: basePriceAtComp,
      basePriceToday,
      baseCardId: baseCard.card_id,
      daysSinceComp,
      confidenceBandLow: Math.round(trendAdjustedPrice * (1 - bandPct) * 100) / 100,
      confidenceBandHigh: Math.round(trendAdjustedPrice * (1 + bandPct) * 100) / 100,
    };
  } catch (err: any) {
    console.warn(
      `[cardhedge.client] computeTrendAdjustment threw for card_id=${parallelCard.card_id}:`,
      err?.message ?? err,
    );
    return null;
  }
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

// ───────────────────────────────────────────────────────────────────────────
// Additional Card Hedge endpoints (CH-only restoration, 2026-06-26)
//
// These power iOS picker, scanner, and detail views. All return CH-native
// shapes — we do NOT layer pricing logic on top here. Our pricing engine
// (MCP /predict + signals + floor + anchor) continues to consume comps from
// findCompsByQuery / getCardSales above and is untouched by this surface.
// ───────────────────────────────────────────────────────────────────────────

const CARD_DETAILS_TTL_SEC = 6 * 3600;
const SET_SEARCH_TTL_SEC = 24 * 3600;
const IMAGE_LOOKUP_TTL_SEC = 24 * 3600;

export interface CardHedgePriceEntry {
  grade: string;
  price: number;
}

export interface CardHedgeCardDetail {
  card_id: string;
  description?: string | null;
  player?: string | null;
  set?: string | null;
  number?: string | null;
  variant?: string | null;
  image?: string | null;
  images?: string[];
  category?: string | null;
  category_group?: string | null;
  set_type?: string | null;
  rookie?: boolean;
  prices: CardHedgePriceEntry[];
  /** Raw CH payload for unknown fields (forward-compat). */
  raw?: Record<string, unknown>;
}

export interface CardHedgeSetInfo {
  name: string;
  year?: number | string | null;
  category?: string | null;
  image?: string | null;
  thirty_day_sales?: number | null;
  raw?: Record<string, unknown>;
}

export interface CardHedgeImageInput {
  image_url?: string;
  image_base64?: string;
}

export interface CardHedgeImageCandidate {
  card_id: string;
  description?: string | null;
  player?: string | null;
  set?: string | null;
  number?: string | null;
  variant?: string | null;
  image?: string | null;
  category?: string | null;
  similarity?: string | number | null;
  confidence?: number | null;
  reasoning?: string | null;
}

export interface CardHedgeImageMatchResult {
  best_match: CardHedgeImageCandidate | null;
  candidates: CardHedgeImageCandidate[];
  query_id?: string | null;
  message?: string | null;
}

export interface CardHedgeImageSearchResult {
  results: Array<{
    similarity?: string | number | null;
    distance?: number | null;
    ximilar_id?: string | null;
    product_id?: string | null;
    card_data?: CardHedgeImageCandidate | null;
  }>;
  total_results: number;
  query_id?: string | null;
  has_cardhedge_matches?: boolean;
}

export interface CardHedgeCertResult {
  cert_info: {
    grader?: string | null;
    cert?: string | null;
    grade?: string | null;
    gemrate_id?: string | null;
    universal_gemrate_id?: string | null;
    description?: string | null;
  } | null;
  card: CardHedgeCardDetail | null;
  card_source?: "gemrate_id" | "card_match" | null;
  match_confidence?: number | null;
}

function normalizePriceEntries(raw: unknown): CardHedgePriceEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p: any) => ({
      grade: String(p?.grade ?? "").trim(),
      price: toFloat(p?.price),
    }))
    .filter((p) => p.grade && p.price > 0);
}

function cardFromAny(c: any): CardHedgeCardDetail | null {
  if (!c || !c.card_id) return null;
  return {
    card_id: String(c.card_id),
    description: c.description ?? c.title ?? null,
    player: c.player ?? null,
    set: c.set ?? null,
    number: c.number ?? null,
    variant: c.variant ?? null,
    image: c.image ?? null,
    images: Array.isArray(c.images) ? c.images.filter((x: unknown) => typeof x === "string") : undefined,
    category: c.category ?? null,
    category_group: c.category_group ?? null,
    set_type: c.set_type ?? null,
    rookie: typeof c.rookie === "boolean" ? c.rookie : undefined,
    prices: normalizePriceEntries(c.prices),
    raw: c,
  };
}

/** POST /cards/card-details — detailed card metadata by card_id. */
export async function getCardDetail(
  cardId: string,
  opts: { rawImagesOnly?: boolean } = {},
): Promise<CardHedgeCardDetail | null> {
  if (!cardId) return null;
  const h = headers();
  if (!h) return null;
  return cacheWrap(
    cacheKey("ch:card-details", cardId, opts.rawImagesOnly ? "raw" : "all"),
    async () => _getCardDetail(cardId, opts, h),
    CARD_DETAILS_TTL_SEC,
  );
}

async function _getCardDetail(
  cardId: string,
  opts: { rawImagesOnly?: boolean },
  h: Record<string, string>,
): Promise<CardHedgeCardDetail | null> {
  try {
    const body: Record<string, unknown> = { card_id: cardId };
    if (opts.rawImagesOnly) body.raw_images_only = true;
    const res = await fetch(`${BASE_URL}/cards/card-details`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[cardhedge.client] card-details HTTP ${res.status} for card_id=${cardId}`);
      return null;
    }
    const json: any = await res.json();
    const cards: any[] = Array.isArray(json?.cards) ? json.cards : [];
    if (cards.length === 0) return null;
    return cardFromAny(cards[0]);
  } catch (err: any) {
    console.warn(`[cardhedge.client] card-details threw for card_id=${cardId}:`, err?.message ?? err);
    return null;
  }
}

/** POST /cards/set-search — set browsing with name + category filters. */
export async function searchSets(
  opts: { search?: string; category?: string; count?: number } = {},
): Promise<CardHedgeSetInfo[]> {
  const h = headers();
  if (!h) return [];
  const count = Math.max(1, Math.min(opts.count ?? 25, 100));
  const search = (opts.search ?? "").trim();
  const category = (opts.category ?? "").trim();
  return cacheWrap(
    cacheKey("ch:set-search", search, category, String(count)),
    async () => _searchSets({ search, category, count }, h),
    SET_SEARCH_TTL_SEC,
  );
}

async function _searchSets(
  opts: { search: string; category: string; count: number },
  h: Record<string, string>,
): Promise<CardHedgeSetInfo[]> {
  try {
    const body: Record<string, unknown> = { count: opts.count };
    if (opts.search) body.search = opts.search;
    if (opts.category) body.category = opts.category;
    const res = await fetch(`${BASE_URL}/cards/set-search`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[cardhedge.client] set-search HTTP ${res.status}`);
      return [];
    }
    const json: any = await res.json();
    const sets: any[] = Array.isArray(json?.sets) ? json.sets : [];
    return sets
      .filter((s) => s?.name)
      .map((s) => ({
        name: String(s.name),
        year: s.year ?? null,
        category: s.category ?? null,
        image: s.image ?? null,
        thirty_day_sales:
          typeof s["30 Day Sales"] === "number"
            ? s["30 Day Sales"]
            : typeof s.thirty_day_sales === "number"
              ? s.thirty_day_sales
              : null,
        raw: s,
      }));
  } catch (err: any) {
    console.warn(`[cardhedge.client] set-search threw:`, err?.message ?? err);
    return [];
  }
}

function buildImageBody(input: CardHedgeImageInput, k?: number): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};
  if (input.image_url && typeof input.image_url === "string") body.image_url = input.image_url;
  else if (input.image_base64 && typeof input.image_base64 === "string") body.image_base64 = input.image_base64;
  else return null;
  if (typeof k === "number" && k > 0) body.k = Math.min(k, 50);
  return body;
}

function imageCacheKeyPart(input: CardHedgeImageInput): string {
  if (input.image_url) return `url:${input.image_url}`;
  if (input.image_base64) {
    // base64 can be huge — hash by length + head/tail to avoid blowing the
    // Redis key. Distinct images collide rarely; cache miss is acceptable.
    const b = input.image_base64;
    return `b64:${b.length}:${b.slice(0, 16)}:${b.slice(-16)}`;
  }
  return "none";
}

/** POST /cards/image-match — AI picks single best card + variant from photo. */
export async function imageMatch(
  input: CardHedgeImageInput,
  opts: { k?: number } = {},
): Promise<CardHedgeImageMatchResult | null> {
  const h = headers();
  if (!h) return null;
  const body = buildImageBody(input, opts.k);
  if (!body) return null;
  return cacheWrap(
    cacheKey("ch:image-match", imageCacheKeyPart(input), String(opts.k ?? 10)),
    async () => _imageMatch(body, h),
    IMAGE_LOOKUP_TTL_SEC,
  );
}

async function _imageMatch(
  body: Record<string, unknown>,
  h: Record<string, string>,
): Promise<CardHedgeImageMatchResult | null> {
  try {
    const res = await fetch(`${BASE_URL}/cards/image-match`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[cardhedge.client] image-match HTTP ${res.status}`);
      return null;
    }
    const json: any = await res.json();
    return {
      best_match: json?.best_match ?? null,
      candidates: Array.isArray(json?.candidates) ? json.candidates : [],
      query_id: json?.query_id ?? null,
      message: json?.message ?? null,
    };
  } catch (err: any) {
    console.warn(`[cardhedge.client] image-match threw:`, err?.message ?? err);
    return null;
  }
}

/** POST /cards/image-search — ranked list of visually similar cards. */
export async function imageSearch(
  input: CardHedgeImageInput,
  opts: { k?: number } = {},
): Promise<CardHedgeImageSearchResult | null> {
  const h = headers();
  if (!h) return null;
  const body = buildImageBody(input, opts.k);
  if (!body) return null;
  return cacheWrap(
    cacheKey("ch:image-search", imageCacheKeyPart(input), String(opts.k ?? 10)),
    async () => _imageSearch(body, h),
    IMAGE_LOOKUP_TTL_SEC,
  );
}

async function _imageSearch(
  body: Record<string, unknown>,
  h: Record<string, string>,
): Promise<CardHedgeImageSearchResult | null> {
  try {
    const res = await fetch(`${BASE_URL}/cards/image-search`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[cardhedge.client] image-search HTTP ${res.status}`);
      return null;
    }
    const json: any = await res.json();
    return {
      results: Array.isArray(json?.results) ? json.results : [],
      total_results: typeof json?.total_results === "number" ? json.total_results : 0,
      query_id: json?.query_id ?? null,
      has_cardhedge_matches: Boolean(json?.has_cardhedge_matches),
    };
  } catch (err: any) {
    console.warn(`[cardhedge.client] image-search threw:`, err?.message ?? err);
    return null;
  }
}

/** POST /cards/details-by-cert-ocr — graded slab photo → cert + card details. */
export async function detailsByCertOcr(
  input: CardHedgeImageInput,
): Promise<CardHedgeCertResult | null> {
  const h = headers();
  if (!h) return null;
  const body = buildImageBody(input);
  if (!body) return null;
  return cacheWrap(
    cacheKey("ch:cert-ocr", imageCacheKeyPart(input)),
    async () => _detailsByCertOcr(body, h),
    IMAGE_LOOKUP_TTL_SEC,
  );
}

async function _detailsByCertOcr(
  body: Record<string, unknown>,
  h: Record<string, string>,
): Promise<CardHedgeCertResult | null> {
  try {
    const res = await fetch(`${BASE_URL}/cards/details-by-cert-ocr`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[cardhedge.client] details-by-cert-ocr HTTP ${res.status}`);
      return null;
    }
    const json: any = await res.json();
    return {
      cert_info: json?.cert_info ?? null,
      card: cardFromAny(json?.card),
      card_source: json?.card_source ?? null,
      match_confidence:
        typeof json?.match_confidence === "number" ? json.match_confidence : null,
    };
  } catch (err: any) {
    console.warn(`[cardhedge.client] details-by-cert-ocr threw:`, err?.message ?? err);
    return null;
  }
}

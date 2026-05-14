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
      body: JSON.stringify({ query, category: "Baseball" }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const confidence = Number(body?.confidence ?? 0);
    if (!Number.isFinite(confidence) || confidence < MIN_IDENTITY_CONFIDENCE) return null;
    if (!body?.card_id) return null;
    return body;
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
): Promise<{ card: CardHedgeCard | null; sales: CardHedgeSale[]; variantWarning: string[] }> {
  const grade = opts.grade ?? "Raw";
  const limit = opts.limit ?? 20;
  if (!query?.trim()) return { card: null, sales: [], variantWarning: [] };

  const tokens = extractRequiredTokens(query);

  // Try high-confidence AI match first.
  const matched = await identifyCard(query);
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

  // 1. Prefer an exact-token match from the AI result.
  let card: CardHedgeCard | null = null;
  if (aiCandidate && cardMatchesTokens(aiCandidate, tokens)) {
    card = aiCandidate;
  }

  // 2. Fall back to searchCards filtered by exact tokens.
  let searchHits: CardHedgeCard[] = [];
  if (!card) {
    searchHits = await searchCards(query, 25);
    card = searchHits.find((h) => cardMatchesTokens(h, tokens)) ?? null;
  }

  // 3. Try simplified query for exact tokens.
  if (!card) {
    const simplified = simplifyQuery(query);
    if (simplified && simplified !== query) {
      const hits = await searchCards(simplified, 25);
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
        `[cardhedge.client] No exact match for "${query}" — using fallback variant="${fallback.variant}" (missing: ${variantWarning.join(", ")})`
      );
      card = fallback;
    }
  }

  if (!card?.card_id) return { card: null, sales: [], variantWarning: [] };
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

  return { card, sales, variantWarning };
}

/**
 * Strip noise tokens that trip up Card Hedge's AI match ("rc", "rookie",
 * "card", "#nnn", duplicate spaces). Keeps year + player + set tokens.
 */
function simplifyQuery(q: string): string {
  return q
    .replace(/#\s*\d+/g, "")
    .replace(/\b(rookie|rc|card|psa|bgs|sgc|gem mint|mint)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Cross-parallel sibling comp fetcher.
//
// When CH has thin/stale comps for the user's target card, pull comps from
// OTHER parallels of the same player+year+set so the neighbor-synthesis
// engine can derive the target price via parallel multipliers (e.g. Blue
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
            // `parallelTierKey()` in neighborSynthesis can classify it.
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

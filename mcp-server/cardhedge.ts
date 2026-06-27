// Card Hedge AI client — used ONLY by the admin/prime endpoint to seed the
// blob cache for a player on demand. The /api/compiq/predict endpoint never
// calls Card Hedge live — it reads from blob (compsLoader.ts).
//
// API: https://api.cardhedger.com/v1
// Auth: X-API-Key: $CARD_HEDGE_API_KEY
// Prices come back as strings in DOLLARS — coerce to float, never /100.

import {
  BlobServiceClient,
  type ContainerClient,
} from "@azure/storage-blob";

const BASE_URL = "https://api.cardhedger.com/v1";
const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_IDENTITY_CONFIDENCE = 0.8;
const CONTAINER = "compiq-signals";

function apiKey(): string {
  const key = process.env.CARD_HEDGE_API_KEY;
  if (!key) throw new Error("CARD_HEDGE_API_KEY not configured");
  return key;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "X-API-Key": apiKey(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Card Hedge ${path} ${resp.status}: ${txt.slice(0, 200)}`);
    }
    return (await resp.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

function toFloat(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

interface CardMatchResponse {
  card_id?: string;
  card?: { card_id?: string };
  confidence?: number;
}

interface CompsResponse {
  raw_prices?: Array<{
    price?: string | number;
    sale_date?: string;
    grade?: string;
    price_source?: string;
    sale_type?: string;
    title?: string;
    sale_url?: string;
  }>;
}

export interface CachedSale {
  price: number;
  date: string;
  grade: string;
  source: string;
  title?: string;
  url?: string;
}

export interface CachedCardHedgePayload {
  player: string;
  raw_sales: CachedSale[];
  card_hedge_id?: string;
  updated_at: string;
}

export async function identifyCard(
  query: string
): Promise<{ card_id: string; confidence: number } | null> {
  if (!query?.trim()) return null;
  try {
    const r = await postJson<CardMatchResponse>("/cards/card-match", {
      query,
      category: "Baseball",
    });
    const cardId = r.card_id ?? r.card?.card_id ?? "";
    const confidence = Number(r.confidence ?? 0);
    if (!cardId || confidence < MIN_IDENTITY_CONFIDENCE) return null;
    return { card_id: cardId, confidence };
  } catch (err) {
    console.warn("[cardhedge] identify failed:", (err as Error).message);
    return null;
  }
}

export async function getCardSales(
  cardId: string,
  grade = "Raw",
  limit = 25
): Promise<CachedSale[]> {
  try {
    const r = await postJson<CompsResponse>("/cards/comps", {
      card_id: cardId,
      count: limit,
      grade,
      include_raw_prices: true,
    });
    return (r.raw_prices ?? [])
      .filter((s) => s.price !== undefined && s.price !== null)
      .map<CachedSale>((s) => ({
        price: toFloat(s.price),
        date: s.sale_date ?? new Date().toISOString(),
        grade: s.grade ?? grade,
        source: s.price_source ?? "card_hedge",
        title: s.title,
        url: s.sale_url,
      }))
      .filter((s) => s.price > 0);
  } catch (err) {
    console.warn("[cardhedge] comps failed:", (err as Error).message);
    return [];
  }
}

function playerSlug(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, "-");
}

function getContainer(): ContainerClient | null {
  const conn = process.env.AZURE_BLOB_CONNECTION_STRING;
  if (!conn) return null;
  try {
    return BlobServiceClient.fromConnectionString(conn).getContainerClient(
      CONTAINER
    );
  } catch {
    return null;
  }
}

export async function writePlayerComps(
  playerName: string,
  cardId: string | undefined,
  sales: CachedSale[]
): Promise<boolean> {
  const container = getContainer();
  if (!container) return false;
  await container.createIfNotExists();
  const path = `${playerSlug(playerName)}/cardhedge.json`;
  const payload: CachedCardHedgePayload = {
    player: playerName,
    raw_sales: sales,
    card_hedge_id: cardId,
    updated_at: new Date().toISOString(),
  };
  const body = JSON.stringify(payload, null, 2);
  const blob = container.getBlockBlobClient(path);
  await blob.upload(body, body.length, {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
  return true;
}

export interface PrimeResult {
  ok: boolean;
  player: string;
  card_id?: string;
  confidence?: number;
  sales_count: number;
  blob_path: string;
  reason?: string;
}

/**
 * Seed the blob cache for a single player by calling Card Hedge live.
 * This is the only place in the MCP server that hits Card Hedge directly.
 */
export async function primePlayerComps(opts: {
  playerName: string;
  query?: string; // free-text card description for card-match
  cardId?: string; // skip card-match if already known
  grade?: string;
  limit?: number;
}): Promise<PrimeResult> {
  const blobPath = `${playerSlug(opts.playerName)}/cardhedge.json`;

  let cardId = opts.cardId;
  let confidence: number | undefined;
  if (!cardId) {
    const matchQuery = opts.query?.trim() || opts.playerName;
    const m = await identifyCard(matchQuery);
    if (!m) {
      return {
        ok: false,
        player: opts.playerName,
        sales_count: 0,
        blob_path: blobPath,
        reason: "no_high_confidence_match",
      };
    }
    cardId = m.card_id;
    confidence = m.confidence;
  }

  const sales = await getCardSales(cardId, opts.grade ?? "Raw", opts.limit ?? 25);
  const wrote = await writePlayerComps(opts.playerName, cardId, sales);

  return {
    ok: wrote,
    player: opts.playerName,
    card_id: cardId,
    confidence,
    sales_count: sales.length,
    blob_path: blobPath,
    reason: wrote ? undefined : "blob_write_failed",
  };
}

// ----------------------------------------------------------------------------
// Card image lookup (used by InventoryIQ to auto-populate images).
//
// Calls Card Hedge /cards/card-search + /cards/card-match. Only returns image
// URLs when the AI text-match confidence is >= 0.80 per project rules.
// Results are cached in blob `{slug}/image.json` with a 7-day TTL (identity
// cache) to avoid hitting Card Hedge live on every iOS view open.
// ----------------------------------------------------------------------------

const IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SearchHit {
  card_id?: string;
  id?: string;
  // Image fields — Card Hedge returns `image` (singular). Older callers may
  // also see image_url / front_image_url / images[]; we accept all.
  image?: string;
  image_url?: string;
  front_image?: string;
  front_image_url?: string;
  back_image_url?: string;
  images?: Array<string | { url?: string }>;
  // Title-ish fields — Card Hedge returns `description` plus structured
  // player/set/number; we also accept legacy `title`/`name`.
  description?: string;
  title?: string;
  name?: string;
  player?: string;
  set?: string;
  number?: string;
  variant?: string;
  rookie?: boolean | string;
}

interface SearchResponse {
  results?: SearchHit[];
  cards?: SearchHit[];
}

interface CachedImagePayload {
  query: string;
  player?: string;
  card_id?: string;
  confidence: number;
  image_urls: string[];
  title?: string;
  updated_at: string;
}

function extractImagesFromHit(hit: SearchHit): string[] {
  const urls: string[] = [];
  const push = (u: unknown) => {
    if (typeof u === "string" && /^https?:\/\//i.test(u)) urls.push(u);
  };
  push(hit.front_image_url);
  push(hit.image_url);
  push(hit.front_image);
  push(hit.image);
  if (Array.isArray(hit.images)) {
    for (const it of hit.images) {
      if (typeof it === "string") push(it);
      else if (it && typeof it === "object") push(it.url);
    }
  }
  push(hit.back_image_url);
  // De-duplicate, cap at 2 (front + back)
  return Array.from(new Set(urls)).slice(0, 2);
}

export interface ImageLookupResult {
  ok: boolean;
  cached: boolean;
  query: string;
  player?: string;
  card_id?: string;
  confidence: number;
  image_urls: string[];
  title?: string;
  reason?: string;
}

async function readCachedImage(
  slug: string
): Promise<CachedImagePayload | null> {
  const container = getContainer();
  if (!container) return null;
  try {
    const blob = container.getBlockBlobClient(`${slug}/image.json`);
    const exists = await blob.exists();
    if (!exists) return null;
    const buf = await blob.downloadToBuffer();
    const payload = JSON.parse(buf.toString("utf-8")) as CachedImagePayload;
    const updated = Date.parse(payload.updated_at);
    if (!Number.isFinite(updated)) return null;
    if (Date.now() - updated > IMAGE_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

async function writeCachedImage(
  slug: string,
  payload: CachedImagePayload
): Promise<void> {
  const container = getContainer();
  if (!container) return;
  try {
    await container.createIfNotExists();
    const body = JSON.stringify(payload, null, 2);
    const blob = container.getBlockBlobClient(`${slug}/image.json`);
    await blob.upload(body, body.length, {
      blobHTTPHeaders: { blobContentType: "application/json" },
    });
  } catch (err) {
    console.warn("[cardhedge] image cache write failed:", (err as Error).message);
  }
}

/**
 * Resolve image URLs for a card description. Uses card-match for confidence
 * gating, then card-search to harvest image URLs from the matched card.
 */
export async function lookupCardImage(opts: {
  query: string;
  playerName?: string;
}): Promise<ImageLookupResult> {
  const query = (opts.query ?? "").trim();
  if (!query) {
    return {
      ok: false,
      cached: false,
      query,
      confidence: 0,
      image_urls: [],
      reason: "empty_query",
    };
  }

  const slug = playerSlug(opts.playerName?.trim() || query);

  // 1. Check 7-day blob cache
  const cached = await readCachedImage(slug);
  if (cached && cached.image_urls.length > 0) {
    return {
      ok: true,
      cached: true,
      query: cached.query,
      player: cached.player,
      card_id: cached.card_id,
      confidence: cached.confidence,
      image_urls: cached.image_urls,
      title: cached.title,
    };
  }

  // 2. Live search — Card Hedge `card-search` returns visually relevant
  //    hits with image fields. We don't need >=0.80 identity confidence to
  //    render an image (that gate is for pricing/comp attribution); we just
  //    need the title to plausibly match the user's card.
  let imageUrls: string[] = [];
  let title: string | undefined;
  let matchedCardId: string | undefined;
  let confidence = 0;

  try {
    const r = await postJson<SearchResponse>("/cards/card-search", {
      search: query,
      category: "Baseball",
      page: 1,
      page_size: 5,
    });
    const hits = r.results ?? r.cards ?? [];
    const matched = pickBestHit(hits, query, opts.playerName);
    if (matched) {
      imageUrls = extractImagesFromHit(matched);
      title = matched.description ?? matched.title ?? matched.name;
      matchedCardId = matched.card_id ?? matched.id;
      confidence = scoreHit(matched, query, opts.playerName);
    }
  } catch (err) {
    console.warn("[cardhedge] image search failed:", (err as Error).message);
  }

  if (imageUrls.length === 0) {
    return {
      ok: false,
      cached: false,
      query,
      player: opts.playerName,
      card_id: matchedCardId,
      confidence,
      image_urls: [],
      reason: matchedCardId ? "no_image_in_match" : "no_high_confidence_match",
    };
  }

  // 4. Cache & return
  const payload: CachedImagePayload = {
    query,
    player: opts.playerName,
    card_id: matchedCardId,
    confidence,
    image_urls: imageUrls,
    title,
    updated_at: new Date().toISOString(),
  };
  await writeCachedImage(slug, payload);

  return {
    ok: true,
    cached: false,
    query,
    player: opts.playerName,
    card_id: matchedCardId,
    confidence,
    image_urls: imageUrls,
    title,
  };
}

// Score a search hit against the original query. We boost when the title
// contains the player's last name and when the year token from the query
// appears in the title. Range is roughly 0..1.
function scoreHit(hit: SearchHit, query: string, playerName?: string): number {
  // Card Hedge returns `description` plus structured player/set/number; older
  // callers fell back to `title`/`name`. Build a single haystack from all of
  // them and score against the query.
  const haystack = [
    hit.description,
    hit.title,
    hit.name,
    hit.player,
    hit.set,
    hit.number,
    hit.variant,
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ")
    .toLowerCase();
  if (!haystack) return 0;
  const q = query.toLowerCase();
  let score = 0.4;
  if (playerName) {
    const last = playerName.trim().split(/\s+/).pop()?.toLowerCase() ?? "";
    if (last && haystack.includes(last)) score += 0.25;
  }
  const yearMatch = q.match(/\b(19|20)\d{2}\b/);
  if (yearMatch && haystack.includes(yearMatch[0])) score += 0.2;
  // Card-number token like "#US175" or "CPA-CBO"
  const numMatch = q.match(/#?[a-z]{0,4}-?\d{1,4}[a-z]?/i);
  if (numMatch) {
    const tok = numMatch[0].replace(/^#/, "").toLowerCase();
    if (tok.length >= 2 && haystack.includes(tok)) score += 0.15;
  }
  return Math.min(1, score);
}

// Pick the highest-scoring hit; require a minimum sanity score so that
// totally-unrelated top hits don't surface a wrong image.
function pickBestHit(
  hits: SearchHit[],
  query: string,
  playerName?: string
): SearchHit | undefined {
  if (!hits.length) return undefined;
  let best: { hit: SearchHit; score: number } | undefined;
  for (const h of hits) {
    const s = scoreHit(h, query, playerName);
    if (!best || s > best.score) best = { hit: h, score: s };
  }
  if (!best) return undefined;
  // Require last-name + year (>=0.65) OR explicit card-number hit (>=0.55).
  return best.score >= 0.55 ? best.hit : undefined;
}

// ---------------------------------------------------------------------------
// CH image-match — true visual identity from an uploaded image URL/base64.
// Used by the iOS scanner via POST /api/compiq/image. Returns the top
// candidate plus the full candidate list so the route can apply its own
// confidence gating.
// ---------------------------------------------------------------------------

export interface CHImageCandidate {
  card_id: string;
  confidence: number;
  title?: string;
  player?: string;
  set?: string;
  year?: string | number;
  number?: string;
  variant?: string;
  image_urls: string[];
}

export interface CHImageMatchResult {
  ok: boolean;
  best?: CHImageCandidate;
  candidates: CHImageCandidate[];
  reason?: string;
}

interface CHImageMatchResponse {
  best_match?: any;
  match?: any;
  card?: any;
  candidates?: any[];
  results?: any[];
}

function normalizeImageCandidate(raw: any): CHImageCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const cardId = raw.card_id ?? raw.id ?? raw.card?.card_id;
  if (!cardId) return null;
  const conf =
    typeof raw.confidence === "number"
      ? raw.confidence
      : typeof raw.score === "number"
      ? raw.score
      : 0;
  return {
    card_id: String(cardId),
    confidence: Number.isFinite(conf) ? conf : 0,
    title: raw.title ?? raw.description ?? raw.name ?? raw.card?.title,
    player: raw.player ?? raw.card?.player,
    set: raw.set ?? raw.card?.set,
    year: raw.year ?? raw.card?.year,
    number: raw.number ?? raw.card?.number,
    variant: raw.variant ?? raw.card?.variant,
    image_urls: extractImagesFromHit(raw as any),
  };
}

/**
 * Call CH /cards/image-match. Provide image_url (preferred — CH fetches it
 * server-side) or image_base64. Returns a normalized candidate list sorted
 * by confidence desc.
 */
export async function imageMatchByUrl(opts: {
  imageUrl?: string;
  imageBase64?: string;
  k?: number;
}): Promise<CHImageMatchResult> {
  if (!opts.imageUrl && !opts.imageBase64) {
    return { ok: false, candidates: [], reason: "no_image_provided" };
  }
  const body: Record<string, unknown> = {};
  if (opts.imageUrl) body.image_url = opts.imageUrl;
  if (opts.imageBase64) body.image_base64 = opts.imageBase64;
  if (typeof opts.k === "number" && opts.k > 0) body.k = opts.k;

  try {
    const r = await postJson<CHImageMatchResponse>("/cards/image-match", body);
    const raws: any[] = [];
    if (Array.isArray(r.candidates)) raws.push(...r.candidates);
    if (Array.isArray(r.results)) raws.push(...r.results);
    if (r.best_match) raws.unshift(r.best_match);
    if (r.match) raws.unshift(r.match);
    if (r.card) raws.unshift(r.card);

    const seen = new Set<string>();
    const candidates: CHImageCandidate[] = [];
    for (const raw of raws) {
      const cand = normalizeImageCandidate(raw);
      if (!cand) continue;
      if (seen.has(cand.card_id)) continue;
      seen.add(cand.card_id);
      candidates.push(cand);
    }
    candidates.sort((a, b) => b.confidence - a.confidence);

    if (candidates.length === 0) {
      return { ok: false, candidates: [], reason: "no_candidates" };
    }
    return { ok: true, best: candidates[0], candidates };
  } catch (err) {
    console.warn("[cardhedge] image-match failed:", (err as Error).message);
    return {
      ok: false,
      candidates: [],
      reason: (err as Error).message ?? "image_match_failed",
    };
  }
}

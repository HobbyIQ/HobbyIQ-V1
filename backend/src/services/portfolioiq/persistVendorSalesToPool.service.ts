// CF-PERSIST-VENDOR-LOOKUPS (Drew, 2026-07-23, issue #722). Every
// external vendor query grows sold_comps. Wraps a batch of vendor
// pricing results, parses each title via parseTitleIdentity, computes
// hobbyiqCardId, and upserts into sold_comps with contentHash dedup.
//
// Fire-and-forget by design — this service NEVER fails the caller.
// A persistence error becomes a warning log. The vendor's response
// still returns to whoever called it.
//
// Feature-flagged: PERSIST_VENDOR_LOOKUPS_ENABLED (default OFF at
// launch — flip after verification). When OFF, this is a no-op.
//
// This is the runtime instance of Drew's "we set the market" moat:
// user traffic itself grows the data pool without any explicit ingest
// scripts.

import { createHash } from "crypto";
import { CosmosClient, type Container } from "@azure/cosmos";
import {
  parseListingIdentity,
  inferSetKeyFromTitle,
  inferSportFromTitle,
} from "./parseTitleIdentity.service.js";
import { resolveVertical } from "./resolveVertical.service.js";
import { computeHobbyIqCardId, slugify, normalizeSetKey as canonicalNormalizeSetKey } from "./hobbyIqCardId.service.js";
import { canonicalizeParallelName } from "../catalog/catalogMatcher.service.js";
import { parseGradeLabel } from "./gradeParser.js";

// CF-CHECKLIST-NARROWER (Drew, 2026-08-02). When parseListingIdentity
// can't extract a cardNumber but we have (player, year, set) triple,
// query card_catalog to see if the checklist resolves to exactly one
// card. Bayesian identity decoder stage 3.5.
let cachedCatalogContainer: Container | null = null;
async function getCatalogContainer(): Promise<Container | null> {
  if (cachedCatalogContainer) return cachedCatalogContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    cachedCatalogContainer = db.container("card_catalog");
    return cachedCatalogContainer;
  } catch { return null; }
}

// In-memory LRU cache for (player+year+set) -> catalog candidates.
// Keeps hot lookups off Cosmos during high-throughput firehose ingest.
const CATALOG_CACHE = new Map<string, Array<{ number: string; parallels: string[]; sport: string | null }>>();
const CATALOG_CACHE_MAX = 5000;

async function checklistNarrow(playerName: string, cardYear: number, setKeyHint: string | null, sportHint: string | null = null): Promise<Array<{ number: string; parallels: string[]; sport: string | null }> | null> {
  const key = `${playerName.toLowerCase()}|${cardYear}|${(setKeyHint ?? "").toLowerCase()}|${(sportHint ?? "").toLowerCase()}`;
  const hit = CATALOG_CACHE.get(key);
  if (hit) return hit;

  const catalog = await getCatalogContainer();
  if (!catalog) return null;

  // Query card_catalog by (player, year). Set constraint applied in-JS
  // to allow fuzzy matching (title has "Topps Update" but catalog stores
  // "2011 Topps Update Baseball" — CONTAINS is more forgiving than exact).
  //
  // CF-CHECKLIST-NARROW-SCHEMA-FIX (Drew, 2026-08-12). This query could
  // never match a row. It was written against a schema card_catalog does
  // not have, in three places at once:
  //   c.player   -> the field is `playerName`   (c.player is undefined)
  //   c.number   -> the field is `cardNumber`   (c.number is undefined)
  //   @y as a STRING -> `year` is stored as a NUMBER, and Cosmos '='
  //                     is type-strict, so '2025' never equals 2025.
  // Zero candidates then fell through to the fuzzy branch below, which
  // carried the same bugs plus a CONTAINS on a nonexistent field — a full
  // cross-partition scan, per sale, structurally incapable of matching.
  // With TCA delivering 1,000-row batches that sustained ~145k RU/s on
  // card_catalog and 130k+ 429s per 5 minutes, all to return nothing.
  // The narrower has resolved zero cardNumbers since it shipped 2026-08-02.
  //
  // NOTE: card_catalog partitions on /cardId (NOT /sport — the comment in
  // cardCatalog.service.ts is wrong). Neither playerName nor year is the
  // partition key, so this is inherently cross-partition; TOP bounds the
  // blast radius.
  try {
    const q = {
      query: "SELECT TOP 200 c.cardNumber, c.setKey, c.parallel, c.sport, c.playerName, c.source, c.confidence FROM c WHERE c.playerName = @p AND c.year = @y AND c.source IN ('cardhedge', 'cardsight', 'sales-derived', 'user-verified', 'ebay-browse')",
      parameters: [
        { name: "@p", value: playerName },
        { name: "@y", value: Number(cardYear) },
      ],
    };
    const { resources } = await catalog.items.query(q).fetchAll();
    let cands = (resources || []).filter((r: { cardNumber?: string }) => r.cardNumber);

    // CF-FUZZY-PLAYER-MATCH (Drew, 2026-08-03). When exact-name match
    // returned nothing, try a broader query and filter in-JS with a
    // small edit-distance / initial-tolerance heuristic. Catches
    // "Mike Trout" vs "Michael Trout", "Ronald Acuna Jr." vs "Ronald
    // Acuña Jr.", "M. Trout" vs "Mike Trout". Gated on
    // FUZZY_PLAYER_MATCH_ENABLED so we can toggle if it introduces
    // wrong-player matches.
    if (cands.length === 0 && process.env.FUZZY_PLAYER_MATCH_ENABLED === "true" && playerName.length >= 4) {
      const lastToken = playerName.trim().split(/\s+/).slice(-1)[0]?.toLowerCase() ?? "";
      if (lastToken.length >= 3) {
        try {
          // CF-CHECKLIST-NARROW-SCHEMA-FIX: same three bugs as above, and
          // this one is the expensive path — CONTAINS(LOWER(...)) cannot use
          // an index, so it scans. Bounded with TOP now that it can actually
          // return rows; it only runs when the exact-name query found none.
          const fq = {
            query: "SELECT TOP 100 c.cardNumber, c.setKey, c.parallel, c.sport, c.playerName FROM c WHERE c.year = @y AND CONTAINS(LOWER(c.playerName ?? ''), @last) AND c.source IN ('cardhedge', 'cardsight', 'sales-derived', 'user-verified', 'ebay-browse')",
            parameters: [
              { name: "@y", value: Number(cardYear) },
              { name: "@last", value: lastToken },
            ],
          };
          const { resources: fuzzy } = await catalog.items.query(fq).fetchAll();
          const target = playerName.toLowerCase().replace(/[^\w\s]/g, "").trim();
          const targetTokens = target.split(/\s+/).filter(Boolean);
          cands = (fuzzy || []).filter((r: { cardNumber?: string; playerName?: string }) => {
            if (!r.cardNumber || !r.playerName) return false;
            const cand = r.playerName.toLowerCase().replace(/[^\w\s]/g, "").trim();
            const candTokens = cand.split(/\s+/).filter(Boolean);
            // Accept when: last name matches AND first-name initial matches
            // (or one side has just the initial). Avoids "Mike Trout" grabbing
            // "Marcus Trout" but tolerates "M Trout" ↔ "Mike Trout".
            const targetLast = targetTokens[targetTokens.length - 1] ?? "";
            const candLast = candTokens[candTokens.length - 1] ?? "";
            if (targetLast !== candLast) return false;
            const targetFirstInit = targetTokens[0]?.[0] ?? "";
            const candFirstInit = candTokens[0]?.[0] ?? "";
            return targetFirstInit === candFirstInit;
          });
        } catch { /* fuzzy failure is soft */ }
      }
    }
    // Apply setKey filter in-JS (case-insensitive contains-either-way).
    if (setKeyHint && cands.length > 1) {
      const sh = setKeyHint.toLowerCase();
      // CF-CHECKLIST-NARROW-SCHEMA-FIX: card_catalog stores `setKey`
      // (a slug like "topps-update"); releaseName/setName do not exist on
      // the row, so this filter silently kept every candidate.
      const strict = cands.filter((r: { setKey?: string }) => {
        const sk = String(r.setKey ?? "").toLowerCase();
        if (!sk) return false;
        return sk.includes(sh) || sh.includes(sk);
      });
      if (strict.length > 0) cands = strict;
    }
    // CF-CATALOG-XVENDOR-DEDUP (Drew, 2026-08-03). Same real card exists
    // in multiple sources (cardsight + cardhedge + sales-derived +
    // user-verified all point at the same Mike Trout 2011 Update Gold).
    // Group by (number, parallel-union) and pick the highest-confidence
    // representative per group. Union parallels + confidences.
    //
    // CF-CATALOG-CONFIDENCE-SORT (Drew, 2026-08-03). Sort candidates by
    // confidence desc so downstream scoring/disambiguation sees the
    // strongest match first. Baseline confidence:
    //   user-verified       0.98  (human confirmed)
    //   cardsight/cardhedge 0.85  (vendor catalog, no per-row confidence)
    //   sales-derived       per-row (0.35–0.95 from log10 count)
    //   canonical/seed/other 0.75 (bootstrap data)
    const SOURCE_BASELINE_CONF: Record<string, number> = {
      "user-verified": 0.98,
      "ebay-browse": 0.92,   // eBay official item-specifics
      cardsight: 0.85,
      cardhedge: 0.85,
      canonical: 0.75,
      seed: 0.70,
      "ch-catalog": 0.80,
    };
    const scoreOf = (r: { source?: string; confidence?: number }) => {
      if (typeof r.confidence === "number" && Number.isFinite(r.confidence)) return r.confidence;
      return SOURCE_BASELINE_CONF[String(r.source ?? "")] ?? 0.60;
    };
    // Group by normalized number — same physical card across sources
    // collapses. Parallel arrays merge; confidence takes the max.
    const consolidated = new Map<string, {
      number: string;
      parallels: Set<string>;
      sport: string | null;
      confidence: number;
      sources: Set<string>;
    }>();
    // CF-CHECKLIST-NARROW-SCHEMA-FIX: rows carry `cardNumber` and a single
    // `parallel` STRING, not `number` and a `parallels` array of objects.
    // The old shape read undefined for both, so every candidate was dropped
    // by the `if (!num) continue` below even in the impossible case that the
    // query had returned something.
    for (const r of cands as Array<{
      cardNumber?: string;
      parallel?: string;
      sport?: string;
      source?: string;
      confidence?: number;
    }>) {
      const num = String(r.cardNumber ?? "").trim();
      if (!num) continue;
      const key = num.toLowerCase();
      let g = consolidated.get(key);
      if (!g) {
        g = { number: num, parallels: new Set(), sport: r.sport ?? null, confidence: 0, sources: new Set() };
        consolidated.set(key, g);
      }
      const conf = scoreOf(r);
      if (conf > g.confidence) g.confidence = conf;
      if (r.source) g.sources.add(r.source);
      const parallelName = String(r.parallel ?? "").trim();
      if (parallelName) g.parallels.add(parallelName);
    }
    const shaped = [...consolidated.values()]
      .sort((a, b) => b.confidence - a.confidence)
      .map((g) => ({
        number: g.number,
        parallels: [...g.parallels],
        sport: g.sport,
      }));

    // CF-TCA-CATALOG-FALLBACK (Drew, 2026-08-03). When our local
    // card_catalog has 0 rows for (player, year, set), fall back to
    // TCA's /catalog beta (15M cards including modern releases we don't
    // index yet). Turns a would-be player-fallback into a cardnumber-
    // precise resolution. Gated on TCA_CATALOG_FALLBACK_ENABLED so we
    // can toggle without redeploy.
    let finalShaped = shaped;
    if (finalShaped.length === 0
        && process.env.TCA_CATALOG_FALLBACK_ENABLED === "true"
        && setKeyHint
        && sportHint) {
      try {
        const { tcaCatalogNarrow } = await import("../compiq/tcaCatalog.client.js");
        const tcaCards = await tcaCatalogNarrow(playerName, cardYear, setKeyHint, sportHint);
        finalShaped = tcaCards.map((c) => ({
          number: String(c.card_number ?? ""),
          parallels: [] as string[],
          sport: sportHint.toLowerCase(),
        })).filter((c) => c.number);
      } catch { /* TCA fallback failure is soft */ }
    }

    // Cache with LRU-ish eviction
    if (CATALOG_CACHE.size >= CATALOG_CACHE_MAX) {
      const firstKey = CATALOG_CACHE.keys().next().value;
      if (firstKey) CATALOG_CACHE.delete(firstKey);
    }
    CATALOG_CACHE.set(key, finalShaped);
    return finalShaped;
  } catch { return null; }
}

// CF-PRICE-BAND-SCORER (Drew, 2026-08-02). Stage 3.6 of the Bayesian
// identity decoder. When checklistNarrow returns 2-5 ambiguous
// candidates, query sold_comps for each candidate's historical price
// distribution and pick the candidate whose median is closest to the
// sale price. Also caches per-(player,year,cardNumber) price bands.
const PRICE_BAND_CACHE = new Map<string, Array<{ parallel: string | null; median: number; n: number }>>();
const PRICE_BAND_CACHE_MAX = 3000;

let cachedSoldCompsContainerForScoring: Container | null = null;
async function getSoldForScoring(): Promise<Container | null> {
  if (cachedSoldCompsContainerForScoring) return cachedSoldCompsContainerForScoring;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    cachedSoldCompsContainerForScoring = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return cachedSoldCompsContainerForScoring;
  } catch { return null; }
}

async function scoreCandidatesByPrice(
  candidates: Array<{ cardNumber: string; parallel: string | null }>,
  ctx: { playerName: string; cardYear: number; price: number },
): Promise<Array<{ cardNumber: string; parallel: string | null; median: number | null; n: number; distanceRatio: number; confidence: number }> | null> {
  if (!candidates.length) return null;
  const sold = await getSoldForScoring();
  if (!sold) return null;

  const results: Array<{ cardNumber: string; parallel: string | null; median: number | null; n: number; distanceRatio: number; confidence: number }> = [];
  for (const c of candidates) {
    const key = `${ctx.playerName.toLowerCase()}|${ctx.cardYear}|${c.cardNumber.toLowerCase()}|${(c.parallel ?? "").toLowerCase()}`;
    let bands = PRICE_BAND_CACHE.get(key);
    if (!bands) {
      try {
        const q = c.parallel
          ? {
              query: "SELECT c.price FROM c WHERE c.playerName = @p AND c.cardYear = @y AND c.cardNumber = @n AND c.parallel = @par AND c.price > 0",
              parameters: [{ name: "@p", value: ctx.playerName }, { name: "@y", value: ctx.cardYear }, { name: "@n", value: c.cardNumber }, { name: "@par", value: c.parallel }],
            }
          : {
              query: "SELECT c.price FROM c WHERE c.playerName = @p AND c.cardYear = @y AND c.cardNumber = @n AND c.price > 0",
              parameters: [{ name: "@p", value: ctx.playerName }, { name: "@y", value: ctx.cardYear }, { name: "@n", value: c.cardNumber }],
            };
        const { resources } = await sold.items.query(q).fetchAll();
        const prices = (resources as Array<{ price: number }>).map((r) => Number(r.price)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
        const median = prices.length > 0 ? prices[Math.floor(prices.length / 2)] : null;
        bands = [{ parallel: c.parallel, median: median ?? 0, n: prices.length }];
        if (PRICE_BAND_CACHE.size >= PRICE_BAND_CACHE_MAX) {
          const firstKey = PRICE_BAND_CACHE.keys().next().value;
          if (firstKey) PRICE_BAND_CACHE.delete(firstKey);
        }
        PRICE_BAND_CACHE.set(key, bands);
      } catch {
        bands = [{ parallel: c.parallel, median: 0, n: 0 }];
      }
    }
    const median = bands[0].median > 0 ? bands[0].median : null;
    const distanceRatio = median ? Math.abs(ctx.price - median) / median : 999;
    results.push({ cardNumber: c.cardNumber, parallel: c.parallel, median, n: bands[0].n, distanceRatio, confidence: 0 });
  }
  // Score: closest distanceRatio wins. Confidence based on margin over runner-up.
  results.sort((a, b) => a.distanceRatio - b.distanceRatio);
  if (results.length === 1) {
    results[0].confidence = results[0].n >= 3 && results[0].distanceRatio < 0.5 ? 0.85 : 0.6;
  } else {
    const winner = results[0]; const runnerUp = results[1];
    if (winner.n < 3) winner.confidence = 0.5;
    else if (winner.distanceRatio < 0.3 && (runnerUp.distanceRatio - winner.distanceRatio) > 0.5) winner.confidence = 0.85;
    else if (winner.distanceRatio < 0.5) winner.confidence = 0.7;
    else winner.confidence = 0.5;
  }
  return results;
}

// CF-GRADE-TIER-RESOLVER (Drew, 2026-08-02). Same Bayesian pattern as
// price-band scorer but for GRADE. When title doesn't specify a grade
// tier (raw / PSA 9 / PSA 10 / BGS 9.5 / etc.), query sold_comps for
// the resolved cardId's price distribution per grade tier and pick the
// tier whose median is closest to the sale price. Returns null when
// insufficient data (< 3 grade tiers observed OR winner's n < 3).
async function resolveGradeTierByPrice(
  ctx: { playerName: string; cardYear: number; cardNumber: string; parallel: string | null; price: number },
): Promise<{ gradeCompany: string | null; gradeValue: number | null; confidence: number } | null> {
  const sold = await getSoldForScoring();
  if (!sold) return null;
  try {
    const q = ctx.parallel
      ? {
          query: "SELECT c.gradeCompany, c.gradeValue, c.price FROM c WHERE c.playerName = @p AND c.cardYear = @y AND c.cardNumber = @n AND c.parallel = @par AND c.price > 0",
          parameters: [{ name: "@p", value: ctx.playerName }, { name: "@y", value: ctx.cardYear }, { name: "@n", value: ctx.cardNumber }, { name: "@par", value: ctx.parallel }],
        }
      : {
          query: "SELECT c.gradeCompany, c.gradeValue, c.price FROM c WHERE c.playerName = @p AND c.cardYear = @y AND c.cardNumber = @n AND c.price > 0",
          parameters: [{ name: "@p", value: ctx.playerName }, { name: "@y", value: ctx.cardYear }, { name: "@n", value: ctx.cardNumber }],
        };
    const { resources } = await sold.items.query(q).fetchAll();
    const rows = resources as Array<{ gradeCompany: string | null; gradeValue: number | null; price: number }>;
    if (rows.length < 3) return null;
    // Group by (gradeCompany, gradeValue) tuple; null tuples = raw
    const buckets = new Map<string, { key: string; company: string | null; value: number | null; prices: number[] }>();
    for (const r of rows) {
      const price = Number(r.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      const key = r.gradeCompany && r.gradeValue !== null ? `${r.gradeCompany.toUpperCase()}::${r.gradeValue}` : "RAW";
      let b = buckets.get(key);
      if (!b) { b = { key, company: r.gradeCompany, value: r.gradeValue, prices: [] }; buckets.set(key, b); }
      b.prices.push(price);
    }
    if (buckets.size < 2) return null;   // need at least 2 tiers to disambiguate
    const scored: Array<{ key: string; company: string | null; value: number | null; median: number; n: number; distanceRatio: number }> = [];
    for (const b of buckets.values()) {
      if (b.prices.length < 2) continue;
      const sorted = b.prices.sort((a, b2) => a - b2);
      const median = sorted[Math.floor(sorted.length / 2)];
      scored.push({ key: b.key, company: b.company, value: b.value, median, n: sorted.length, distanceRatio: Math.abs(ctx.price - median) / median });
    }
    if (scored.length < 2) return null;
    scored.sort((a, b) => a.distanceRatio - b.distanceRatio);
    const winner = scored[0]; const runnerUp = scored[1];
    if (winner.n < 3) return null;
    // Only assign when winner is clearly better than runner-up
    const confidence = winner.distanceRatio < 0.3 && (runnerUp.distanceRatio - winner.distanceRatio) > 0.5 ? 0.85 : winner.distanceRatio < 0.5 ? 0.7 : 0.55;
    if (confidence < 0.55) return null;
    return { gradeCompany: winner.company, gradeValue: winner.value, confidence };
  } catch { return null; }
}

export interface VendorSaleRow {
  title: string | null;
  price: number | null | undefined;
  soldAt: string | null | undefined;       // ISO date
  url?: string | null;
  externalId?: string | null;              // vendor's ID if available; falls back to hash of url/title/price
  // CF-IMAGE-VERIFY-INGEST (Drew, 2026-07-28). Image URL from the
  // vendor's sale record. When present alongside a catalog reference
  // phash, ingest hashes and compares — mismatch routes to verify.
  imageUrl?: string | null;
}

export interface VendorPersistIdentityHint {
  playerName?: string | null;
  cardYear?: number | null;
  sport?: string | null;
  cardNumberRe?: RegExp;
  /** CF-CH-CARDID-PRESERVE (Drew, 2026-07-23). When CH provides a real
   *  cardId for the query, pass it here so persisted rows use the CH
   *  cardId as their partition key. This makes future readCompsByCardId
   *  lookups against the same CH id find these rows too — belt and
   *  suspenders alongside the hobbyiqCardId slug lookup. */
  vendorCardId?: string | null;
  /** CF-TCA-STRUCTURED-HINT (Drew, 2026-08-02). When the vendor pre-
   *  populates identity fields (TCA does on ~17% of rows via its own
   *  eBay-title matcher), pass them here so we skip the fragile
   *  parseListingIdentity title-guess step. Massively raises pass rate
   *  on TCA webhook batches — otherwise TCA titles like
   *  "2025 Bowman Chrome Junior Caminero Pulsar Refractor #/399 Rays"
   *  parse to cardNumber=null even though TCA gave us card_number=BCP-XX
   *  directly. */
  cardNumber?: string | null;
  parallel?: string | null;
  isAuto?: boolean | null;
  printRun?: number | null;
  setName?: string | null;
}

export interface VendorPersistResult {
  inserted: number;
  deduped: number;
  skipped: number;                          // rows that couldn't be parsed to identity
  catalogUnmatched: number;                 // rows whose computed slug has no matching card_catalog entry — held for admin review
}

// CF-CATALOG-MATCH-ONLY (Drew, 2026-08-08). The catalog is CURATED.
// Ingest matches against it; ingest never grows it. Slugs that don't
// match a catalog entry get held for admin review (approve → add to
// catalog, reject → drop) instead of silently minting new catalog rows.
// This preserves catalog credibility (auto-created rows from bad vendor
// data corrupted trends + FMV; 1.86M sales-derived duplicates were the
// evidence).

// In-process cache of "does this slug exist in card_catalog?" — avoids
// re-querying for hot slugs within a single batch. 5min TTL is plenty
// for batch processing; longer would risk staleness if Drew admits a
// new catalog entry mid-batch.
const catalogMatchCache = new Map<string, { present: boolean; expiresAt: number }>();
const CATALOG_MATCH_CACHE_TTL_MS = 5 * 60_000;

async function catalogHasSlug(slug: string): Promise<boolean> {
  const now = Date.now();
  const cached = catalogMatchCache.get(slug);
  if (cached && cached.expiresAt > now) return cached.present;
  try {
    const conn = process.env.COSMOS_CONNECTION_STRING;
    if (!conn) return true; // fail-open when Cosmos isn't wired (tests, local dev)
    const client = new CosmosClient(conn);
    const cat = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
    // Point-lookup by field. Query returns 0 or 1+ counts; either way
    // cheap since hobbyiqCardId is the canonical join key.
    const { resources } = await cat.items.query<number>({
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s",
      parameters: [{ name: "@s", value: slug }],
    }).fetchAll();
    const present = (resources[0] ?? 0) > 0;
    catalogMatchCache.set(slug, { present, expiresAt: now + CATALOG_MATCH_CACHE_TTL_MS });
    return present;
  } catch {
    // Fail-open on Cosmos hiccup — better to over-ingest than to drop
    // legitimate comps due to a transient lookup failure.
    return true;
  }
}

export function isPersistVendorLookupsEnabled(): boolean {
  return process.env.PERSIST_VENDOR_LOOKUPS_ENABLED === "true";
}

let cachedContainer: Container | null = null;
async function getSoldCompsContainer(): Promise<Container | null> {
  if (cachedContainer) return cachedContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    cachedContainer = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return cachedContainer;
  } catch {
    return null;
  }
}

/** Persist a batch of vendor pricing rows into sold_comps with
 *  hobbyiqCardId + contentHash dedup. Never throws — errors become
 *  warning logs and the function returns partial results. */
export async function persistVendorSalesToPool(
  source: "cardsight" | "cardhedge" | "tca-ebay",
  rows: VendorSaleRow[],
  identity: VendorPersistIdentityHint = {},
): Promise<VendorPersistResult> {
  const result: VendorPersistResult = { inserted: 0, deduped: 0, skipped: 0, catalogUnmatched: 0 };
  if (!isPersistVendorLookupsEnabled()) return result;
  if (!Array.isArray(rows) || rows.length === 0) return result;
  const container = await getSoldCompsContainer();
  if (!container) return result;

  // CF-LLM-BATCH-PREWARM (Drew, 2026-08-03). Before the main
  // per-row loop, if PERSIST_LLM_BATCH_ENABLED=true AND this is a
  // background batch (>= 2 rows), collect every title that WILL
  // trigger an LLM call (missing critical identity + parseable
  // length) and pre-resolve them via parseTitlesBatchWithAi in a
  // single bundled LLM call. Results cache, so the main loop's
  // parseTitleWithAi calls become cache hits — same behavior, ~40%
  // fewer LLM API calls end-to-end. User-facing single-row callers
  // (rows.length === 1) skip this pass so they aren't slowed
  // waiting for a batch to fill.
  if (process.env.PERSIST_LLM_BATCH_ENABLED === "true"
      && process.env.PERSIST_LLM_ENRICH_ENABLED === "true"
      && rows.length >= 2) {
    try {
      const candidateTitles: string[] = [];
      for (const row of rows) {
        const title = String(row.title ?? "").trim();
        if (title.length < 15) continue;
        // Skip rows that won't hit LLM even after regex: we mimic
        // the same gating as the main loop (sports-only, missing
        // critical fields). Pre-resolve for anything that MIGHT
        // trigger LLM — over-inclusion is fine (cache hits are cheap).
        candidateTitles.push(title);
      }
      if (candidateTitles.length > 0) {
        const { parseTitlesBatchWithAi } = await import("./titleParserAi.service.js");
        // Result is cached per-title inside the helper — we don't
        // need the return value directly; the main loop below reads
        // cache via parseTitleWithAi.
        await parseTitlesBatchWithAi(candidateTitles);
      }
    } catch { /* soft — main loop still works without pre-warm */ }
  }

  // CF-PERSIST-PER-SALE-FANOUT (Drew, 2026-08-15: "let's fix the 289 call
  // it will save money and time"). This loop issued THREE cross-partition
  // Cosmos queries for every single sale — the dedup existence check, the
  // rolling-30d median, and the price-anomaly cohort. A search that
  // persists a few hundred comps therefore fired several hundred queries.
  //
  // Measured against prod: POST /api/compiq/search runs p50 1.91s but p90
  // 10.29s, and latency tracks query count almost exactly — 289 Cosmos
  // calls on searches under 2s, 618 on searches over 10s, peak 5,663. The
  // same queries are also the bulk of the App Insights bill: 156M
  // dependency records in two days, ~88% of ingested telemetry volume.
  //
  // The two OUTLIER-CONTEXT reads are memoised per call below. Both are
  // keyed on values that repeat heavily inside one batch — every comp of
  // the same card shares a slug, and a cohort is shared by every sale of
  // the same player/year/parallel/grade — so the repeat queries were
  // re-asking a question already answered.
  //
  // Batch-scoped on purpose, NOT a module-level cache: these reads are
  // "what did the pool look like before this batch", and holding them
  // across calls would serve stale context to a later ingest.
  //
  // The dedup check is deliberately NOT memoised. It is the one query
  // here that decides whether a row is written, and a stale answer would
  // either duplicate a sale or silently drop one. It stays a live read.
  const rollingPricesBySlug = new Map<string, number[]>();
  const anomalyCohortByKey = new Map<string, number[]>();

  for (const row of rows) {
    const title = String(row.title ?? "").trim();
    const price = Number(row.price);
    const soldAt = String(row.soldAt ?? "").trim();
    if (!title || !Number.isFinite(price) || price <= 0 || !soldAt) {
      result.skipped++;
      continue;
    }
    // CF-TCA-STRUCTURED-HINT (Drew, 2026-08-02): identity hint fields
    // (cardNumber / parallel / isAuto / printRun / setName) take priority
    // over the title-guess fallback. When the vendor pre-populated
    // structured identity (TCA gives us these on ~17% of rows), we skip
    // the fragile parseListingIdentity call for the corresponding field.
    const parsed = parseListingIdentity(title, identity.cardNumberRe);
    let cardNumber = identity.cardNumber ?? parsed.cardNumber;
    let cardYear = identity.cardYear ?? guessCardYearFromTitle(title);
    let playerName = identity.playerName ?? guessPlayerFromTitle(title);
    let setKey = identity.setName ?? inferSetKeyFromTitle(title);
    // CF-VERTICAL-NOT-SPORT wired in (Drew, 2026-08-14: "if tcg is done then
    // those pending should flow quickly in backfill"). They will not, unless
    // the vertical is resolved here — inferSportFromTitle defaults to
    // "baseball", so a Pokemon sale computed hiq:baseball:… and could never
    // meet the 68,926 rows just ingested at hiq:pokemon:….
    //
    // resolveVertical checks TCG FIRST (a Pokemon title contains no sport
    // keyword, so it would otherwise fall straight through to the default) and
    // reports whether it was confident, which the caller records below.
    const verticalRes = resolveVertical({
      declared: identity.sport,
      title,
      fallback: "baseball",
    });
    let sport = verticalRes.vertical;

    // CF-LLM-FALLBACK (Drew, 2026-08-03). When regex + guess helpers
    // couldn't extract cardYear OR playerName from the title, but the
    // title has enough content to be worth trying, ask the LLM to
    // extract them. Feature-flagged via PERSIST_LLM_ENRICH_ENABLED so
    // we can toggle without a redeploy. Cache prevents duplicate calls
    // for the same title (90d TTL). Rescues non-standard sports formats.
    //
    // CF-LLM-SPORTS-ONLY (Drew, 2026-08-03). We ingest Pokemon/TCG/
    // non-sport rows so the raw data stays queryable, but we don't
    // spend LLM budget cleaning them — they're not part of the
    // pricing product. All LLM TPM goes to sports where value lives.
    // Skip enrichment when sport is already tagged non-sport.
    const NON_SPORTS_TAGS = new Set(["pokemon", "yugioh", "tcg-other", "anime-tcg", "non-sport"]);
    const skipLlmForSport = sport ? NON_SPORTS_TAGS.has(sport.toLowerCase()) : false;
    let llmParsed: import("./titleParserAi.service.js").AiParsedTitle | null = null;
    if (
      process.env.PERSIST_LLM_ENRICH_ENABLED === "true"
      && !skipLlmForSport
      && (!cardYear || !playerName || !cardNumber)
      && title.length >= 15
    ) {
      try {
        const { parseTitleWithAi } = await import("./titleParserAi.service.js");
        // Text-only pass first (fast, cheap, cached).
        llmParsed = await parseTitleWithAi(title);
        // Vision fallback (Drew, 2026-08-03): if text-only failed to
        // yield critical fields AND we have an image URL, retry with
        // vision. Gated on LLM_VISION_ENABLED so we can tune cost.
        // The image often disambiguates Pokemon/vintage/typo cases
        // where the title alone is too vague.
        //
        // CF-VISION-PRICE-GATE (Drew, 2026-08-03). Vision doubles the
        // token cost per row. Restrict to price >= LLM_VISION_MIN_PRICE
        // ($50 default) so we only spend vision budget on high-value
        // rows where identity correctness matters most. Env-tunable
        // so we can lower once TPM headroom grows.
        const visionMinPrice = Number(process.env.LLM_VISION_MIN_PRICE ?? "50");
        const stillMissing = (
          (!cardNumber && !llmParsed?.cardNumber)
          || (!cardYear && !llmParsed?.cardYear)
          || (!playerName && !llmParsed?.playerName)
        );
        if (
          stillMissing
          && row.imageUrl
          && process.env.LLM_VISION_ENABLED === "true"
          && price >= visionMinPrice
        ) {
          const visionParsed = await parseTitleWithAi(title, row.imageUrl);
          if (visionParsed && (visionParsed.cardNumber || visionParsed.cardYear || visionParsed.playerName)) {
            // Merge: vision fills gaps text-only left; text-only holds where
            // vision returned null (rare, but possible).
            llmParsed = {
              cardNumber: llmParsed?.cardNumber ?? visionParsed.cardNumber,
              parallel: (llmParsed?.parallel && llmParsed.parallel !== "Base") ? llmParsed.parallel : visionParsed.parallel,
              isAuto: llmParsed?.isAuto || visionParsed.isAuto,
              printRun: llmParsed?.printRun ?? visionParsed.printRun,
              confidence: visionParsed.confidence, // vision is generally higher
              reasoning: `text+vision: ${visionParsed.reasoning}`,
              cardYear: llmParsed?.cardYear ?? visionParsed.cardYear,
              playerName: llmParsed?.playerName ?? visionParsed.playerName,
              setName: llmParsed?.setName ?? visionParsed.setName,
              sport: llmParsed?.sport ?? visionParsed.sport,
            };
          }
        }
      } catch { /* LLM failure is non-fatal — fall through to existing gates */ }
      if (llmParsed) {
        if (!cardNumber && llmParsed.cardNumber) cardNumber = llmParsed.cardNumber;
        if (!cardYear && llmParsed.cardYear) cardYear = llmParsed.cardYear;
        if (!playerName && llmParsed.playerName) playerName = llmParsed.playerName;
        // "Unknown" is the inferSetKeyFromTitle sentinel for
        // Pokemon/TCG/non-sport titles — treat it as missing so
        // llmParsed.setName can override.
        if ((!setKey || setKey === "Unknown") && llmParsed.setName) setKey = llmParsed.setName;
        if (!sport && llmParsed.sport) sport = llmParsed.sport;
        // Adopt LLM's parallel/isAuto/printRun only when parser had nothing
        if ((!parsed.parallel || parsed.parallel === "Base") && llmParsed.parallel && llmParsed.parallel !== "Base") {
          parsed.parallel = llmParsed.parallel;
        }
        if (!parsed.isAuto && llmParsed.isAuto) parsed.isAuto = true;
        if (parsed.printRun === null && llmParsed.printRun) parsed.printRun = llmParsed.printRun;
      }
    }

    if (!cardYear) { result.skipped++; continue; }
    if (!playerName) { result.skipped++; continue; }

    // CF-CHECKLIST-NARROWER + PRICE-BAND-SCORER (Drew, 2026-08-02).
    // Stage 3.5 + 3.6 of the Bayesian identity decoder:
    // 1. checklistNarrow: card_catalog candidates matching (player, year, set)
    // 2. When ambiguous, narrow by parallel hint from title
    // 3. When STILL ambiguous, score each candidate by sale-price
    //    distance from that candidate's historical median (via
    //    scoreCandidatesByPrice). Pick highest-confidence winner.
    let checklistConfidence = 1.0;   // 1.0 = title-parsed, 0.85 = price-scored, 0.7 = checklist-single, 0.5 = ambiguous
    if (!cardNumber && playerName && cardYear && setKey) {
      const cands = await checklistNarrow(playerName, cardYear, setKey, sport);
      if (cands && cands.length > 0) {
        if (cands.length === 1) {
          cardNumber = cands[0].number;
          checklistConfidence = 0.7;
        } else {
          // Try parallel-filter first
          let filtered = cands;
          if (parsed.parallel && parsed.parallel !== "Base") {
            const parMatch = cands.filter((c) => c.parallels.some((p) => p.toLowerCase() === String(parsed.parallel ?? "").toLowerCase()));
            if (parMatch.length > 0) filtered = parMatch;
          }
          if (filtered.length === 1) {
            cardNumber = filtered[0].number;
            checklistConfidence = 0.7;
          } else if (filtered.length <= 5) {
            // Score remaining candidates by price band
            const scored = await scoreCandidatesByPrice(
              filtered.map((c) => ({ cardNumber: c.number, parallel: parsed.parallel ?? null })),
              { playerName, cardYear, price },
            );
            if (scored && scored.length > 0 && scored[0].confidence >= 0.5) {
              cardNumber = scored[0].cardNumber;
              checklistConfidence = scored[0].confidence;
            } else if (filtered.length <= 3) {
              // Fallback: pick first with low confidence
              cardNumber = filtered[0].number;
              checklistConfidence = 0.5;
            }
          }
          // filtered.length > 5 → too ambiguous, skip
        }
      }
    }

    // CF-PLAYER-FALLBACK-CARDNUMBER (Drew, 2026-08-03). Modern releases
    // (2025-26 Topps Finest, current-year Bowman Chrome, etc.) aren't in
    // card_catalog yet, so checklistNarrow returns nothing and cardNumber
    // stays null. Previously these rows silently dropped. Now: when we
    // have year+player+set+sport but no cardNumber, synthesize a
    // "player-fallback" cardNumber (`pf-<playerSlug>`) so the row lands.
    //
    // The prefix `pf-` marks the row as player-precision (not
    // cardNumber-precision). Downstream code that needs cardNumber-precise
    // rows for FMV/calibration MUST filter these out — group them together
    // as "unspecified card, this player + set + parallel" which is still
    // useful for listing-price ranges but not for canonical FMV.
    //
    // Gated on PLAYER_FALLBACK_CARDNUMBER_ENABLED so we can toggle.
    let identityMethod: "cardnumber-precise" | "player-fallback" = "cardnumber-precise";
    if (!cardNumber
        && process.env.PLAYER_FALLBACK_CARDNUMBER_ENABLED === "true"
        && sport
        && !NON_SPORTS_TAGS.has(sport.toLowerCase())
        && cardYear
        && setKey
        && playerName) {
      cardNumber = `pf-${slugify(playerName)}`;
      identityMethod = "player-fallback";
    }
    if (!cardNumber) { result.skipped++; continue; }
    // Rebind parsed so downstream code uses the hint values.
    parsed.cardNumber = cardNumber;
    if (identity.parallel !== undefined && identity.parallel !== null) parsed.parallel = identity.parallel;
    if (identity.isAuto !== undefined && identity.isAuto !== null) parsed.isAuto = identity.isAuto;
    if (identity.printRun !== undefined && identity.printRun !== null) parsed.printRun = identity.printRun;
    // CF-INGEST-TIME-CANONICALIZE (Drew, 2026-08-04). Normalize the
    // parallel via the catalog matcher's canonicalizer BEFORE computing
    // the slug. Handles case-dedup ("Base"/"base"), market-language
    // aliases ("True Blue" → "Blue Refractor"), and bracket variants
    // ("[Base]" → "Base"). Zero Cosmos calls — pure in-memory
    // transformation. Every new sale from now lands with a canonical
    // parallel that matches other sales of the same physical card,
    // eliminating the "639 Base + 55 base + 23 Refractor" duplicate
    // pattern we saw in the 2024 Bowman Chrome rollup dry-run.
    const canonicalParallel = canonicalizeParallelName(parsed.parallel);
    parsed.parallel = canonicalParallel;

    let slug: string;
    try {
      slug = computeHobbyIqCardId({
        sport,
        year: cardYear,
        setKey,
        cardNumber: parsed.cardNumber,
        parallel: canonicalParallel,
        isAuto: parsed.isAuto,
        printRun: parsed.printRun,
      });
    } catch {
      result.skipped++;
      continue;
    }
    // CF-CATALOG-MATCH-ONLY-RESOLVE (Drew, 2026-08-08 rev 2). The
    // catalog is curated — ingest MATCHES against it. Not just an exact-
    // slug check: RESOLVE via the fuzzy catalog matcher (canonicalize)
    // which handles setKey drift ("Bowman Chrome Draft Picks &
    // Prospects" → real catalog entry at :bowman-draft:), parallel
    // aliases, family fallback. When resolve returns found:true, we
    // rebind `slug` to the RESOLVED slug — so sold_comps writes land
    // under the catalog's canonical identity, not the vendor title's
    // guess. When found:false, sale is held for admin review.
    //
    // MUST run BEFORE contentHash (dedup key depends on slug) so the
    // hash matches other sales of the same physical card even when the
    // vendor titles differ in setName.
    if (process.env.CATALOG_MATCH_ONLY_ENABLED === "true") {
      try {
        const { canonicalize } = await import("../catalog/catalogMatcher.service.js");
        const resolved = await canonicalize({
          sport: sport ?? "",
          year: cardYear,
          setName: setKey,
          cardNumber: parsed.cardNumber,
          parallel: parsed.parallel,
          isAuto: parsed.isAuto ?? false,
          printRun: parsed.printRun ?? null,
          player: playerName,
          source: source === "cardhedge" ? "cardhedge"
                 : source === "cardsight" ? "cardsight"
                 : source === "tca-ebay" ? "tca"
                 : "ebay-title",
          sourceExternalId: row.externalId ?? identity.vendorCardId ?? null,
        });
        if (!resolved.found) {
          result.catalogUnmatched++;
          continue;
        }
        // Rebind slug to the CATALOG's canonical form when it differs
        // from what we computed. This is the fix that lets a "Bowman
        // Chrome Draft" ebay title land its sales under the real
        // "Bowman Draft" catalog entry.
        // CF-CONFIDENCE-MUST-BE-HONOURED (Drew, 2026-08-14). Shares one
        // decision with recordSoldComp — these two had separate copies, which
        // is why the same invariant needed fixing twice.
        const { adoptResolvedSlug } = await import("../catalog/catalogMatcher.service.js");
        const adoption = adoptResolvedSlug(slug, resolved);
        if (adoption.rebound) {
          console.log(JSON.stringify({
            event: "catalog_resolve_slug_rebind",
            source: "persistVendorSalesToPool",
            vendorSource: source,
            computedSlug: slug,
            resolvedSlug: adoption.slug,
            matchedBy: resolved.matchedBy,
            confidence: resolved.confidence,
          }));
          slug = adoption.slug;
        } else if (adoption.refusedReason) {
          console.log(JSON.stringify({
            event: "catalog_resolve_rebind_refused",
            source: "persistVendorSalesToPool",
            vendorSource: source,
            computedSlug: slug,
            candidateSlug: resolved.slug,
            reason: adoption.refusedReason,
          }));
        }
      } catch (err) {
        // Resolve failure = treat as unmatched (fail-closed under match-only).
        result.catalogUnmatched++;
        console.warn(JSON.stringify({
          event: "catalog_resolve_error",
          source: "persistVendorSalesToPool",
          slug,
          error: (err as Error)?.message ?? String(err),
        }));
        continue;
      }
    }

    // ContentHash for sold_comps dedup. MUST be computed AFTER the
    // catalog resolve above so it uses the RESOLVED slug — two vendor
    // titles for the same physical card (different setName spellings)
    // now produce the same slug via canonicalize, so the same
    // contentHash, so they dedup correctly instead of double-inserting.
    const contentHash = createHash("sha256").update(
      `${slug}|${price.toFixed(2)}|${soldAt.slice(0, 10)}|${source}|${row.url ?? ""}`,
    ).digest("hex").slice(0, 32);

    // CF-COMPS-STAGING-SHIM-EARLY (Drew, 2026-07-28). Staging is the
    // immutable landing zone — it must receive EVERY vendor record
    // we're offered, including ones that dedup against sold_comps.
    // Placed before the sold_comps dedup check so provenance is
    // preserved regardless of downstream state.
    //
    // Fire-and-forget: never blocks the pool write or delays it.
    // Gated on COMPS_STAGING_SHIM_ENABLED so the code is dormant
    // during initial rollout.
    if (process.env.COMPS_STAGING_SHIM_ENABLED === "true") {
      void (async () => {
        try {
          const { stageIngestedComp, computeStagingContentHash } = await import("./compsStaging.service.js");
          let mirroredImage;
          if (row.imageUrl && process.env.COMPS_STAGING_MIRROR_ENABLED === "true") {
            try {
              const { mirrorVendorImage } = await import("./imageMirror.service.js");
              const mirror = await mirrorVendorImage(String(row.imageUrl), `${slug.slice(4)}-${contentHash.slice(0, 8)}`);
              mirroredImage = mirror.ok ? {
                blobUrl: mirror.image.blobUrl,
                contentHash: mirror.image.contentHash,
                size: mirror.image.size,
                contentType: mirror.image.contentType,
                mirroredAt: mirror.image.mirroredAt,
              } : {
                blobUrl: "",
                contentHash: "",
                size: 0,
                contentType: "",
                mirroredAt: new Date().toISOString(),
                mirrorError: { reason: mirror.reason, detail: mirror.detail },
              };
            } catch { /* mirror is optional */ }
          }
          const stagingContentHash = computeStagingContentHash({
            cardYear,
            cardNumber: parsed.cardNumber,
            parallel: parsed.parallel,
            isAuto: parsed.isAuto,
            price,
            soldAt: new Date(soldAt).toISOString(),
          });
          await stageIngestedComp({
            hobbyiqCardId: slug,
            raw: {
              vendor: source,
              vendorRawId: row.externalId ?? identity.vendorCardId ?? null,
              vendorPayload: {
                title,
                price,
                soldAt: new Date(soldAt).toISOString(),
                url: row.url ?? null,
                imageUrl: row.imageUrl ?? null,
                externalId: row.externalId ?? null,
              },
              identityHint: {
                playerName,
                cardYear,
                sport,
                vendorCardId: identity.vendorCardId ?? null,
              },
              fetchedAt: new Date().toISOString(),
              contentHash: stagingContentHash,
            },
            mirroredImage,
          });
        } catch { /* staging shim never blocks the pool write */ }
      })();
    }

    try {
      const { resources: existing } = await container.items.query({
        query: "SELECT c.id FROM c WHERE c.hobbyiqCardId = @hiq AND c.contentHash = @ch",
        parameters: [{ name: "@hiq", value: slug }, { name: "@ch", value: contentHash }],
      }).fetchAll();
      if (existing.length > 0) { result.deduped++; continue; }

      // CF-VERIFY-PARSER-LOW-CONFIDENCE (Drew, 2026-07-28). See
      // parserSuspicionDetector for the rule + rationale.
      const { isParserProbablyWrong } = await import("./parserSuspicionDetector.js");
      if (isParserProbablyWrong({ parsedParallel: parsed.parallel, title })) {
        try {
          const { enqueueForVerify } = await import("./verifyQueue.service.js");
          await enqueueForVerify({
            reason: "parser-low-confidence",
            saleInput: {
              cardId: identity.vendorCardId ?? `hiq:${slug.slice(4)}`,
              playerName,
              cardYear,
              setName: setKey,
              parallel: parsed.parallel,
              cardNumber: parsed.cardNumber,
              isAuto: parsed.isAuto,
              gradeCompany: null,
              gradeValue: null,
              price,
              soldAt: new Date(soldAt).toISOString(),
              source,
              sourceExternalId: row.externalId ?? null,
              title,
              imageUrl: null,
              sellerHandle: null,
              sport,
              verifiedByUser: false,
              confidence: 0.3,
            },
            signal: {
              parserConfidence: 0.4,
              note: `parser tagged Base but title carries a color word + parallel-adjacent context — probable miss`,
            },
          });
          result.skipped++;
          continue;
        } catch {
          // Non-fatal — fall through and persist as Base.
        }
      }

      // CF-VERIFY-SAMPLE-AUDIT (Drew, 2026-07-28). Random 0.5%
      // (env-tunable) of ingests get enqueued regardless of any signal
      // so Drew can spot-check the base rate of ingest quality —
      // the number he calls when he says "we're 99.9% accurate."
      // Sampling is bounded so the queue never becomes noise.
      const sampleRate = Number(process.env.VERIFY_SAMPLE_AUDIT_RATE ?? "0.005");
      if (Number.isFinite(sampleRate) && sampleRate > 0 && Math.random() < sampleRate) {
        try {
          const { enqueueForVerify } = await import("./verifyQueue.service.js");
          await enqueueForVerify({
            reason: "sample-audit",
            saleInput: {
              cardId: identity.vendorCardId ?? `hiq:${slug.slice(4)}`,
              playerName,
              cardYear,
              setName: setKey,
              parallel: parsed.parallel,
              cardNumber: parsed.cardNumber,
              isAuto: parsed.isAuto,
              gradeCompany: null,
              gradeValue: null,
              price,
              soldAt: new Date(soldAt).toISOString(),
              source,
              sourceExternalId: row.externalId ?? null,
              title,
              imageUrl: null,
              sellerHandle: null,
              sport,
              verifiedByUser: false,
              confidence: 0.7,
            },
            signal: { note: `random ${(sampleRate * 100).toFixed(2)}% sample for statistical accuracy audit` },
          });
          // Fall through — sample-audit does NOT block the persist.
          // The sample sits in verify_queue for review AND the row
          // still lands in sold_comps so the pool stays complete.
        } catch {
          // Non-fatal
        }
      }

      // CF-VERIFY-QUEUE-PRICE-OUTLIER (Drew, 2026-07-28). Before we
      // commit this sale to the pool, sanity-check against the
      // rolling 30d median for the same slug. If we're >3× median or
      // <1/3× median AND the slug already has ≥5 comps for context,
      // divert to verify_queue instead of poisoning the pool. Cheap:
      // single indexed query on hobbyiqCardId.
      try {
        // Memoised per batch — every comp of this card asks for the same
        // 30d window, so this was the single most repeated query here.
        let rollingPrices = rollingPricesBySlug.get(slug);
        if (!rollingPrices) {
          const rollingCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
          const { resources: rollingRows } = await container.items.query<{ price: number }>({
            query: "SELECT c.price FROM c WHERE c.hobbyiqCardId = @hiq AND c.soldAt >= @cutoff",
            parameters: [{ name: "@hiq", value: slug }, { name: "@cutoff", value: rollingCutoff }],
          }).fetchAll();
          rollingPrices = (rollingRows ?? []).map((r) => Number(r.price));
          rollingPricesBySlug.set(slug, rollingPrices);
        }
        if (rollingPrices.length >= 5) {
          const prices = rollingPrices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
          if (prices.length >= 5) {
            const rollingMedian = prices[Math.floor(prices.length / 2)];
            const ratio = price / rollingMedian;
            if (ratio > 3 || ratio < (1 / 3)) {
              const { enqueueForVerify } = await import("./verifyQueue.service.js");
              await enqueueForVerify({
                reason: "price-outlier",
                saleInput: {
                  cardId: identity.vendorCardId ?? `hiq:${slug.slice(4)}`,
                  playerName,
                  cardYear,
                  setName: setKey,
                  parallel: parsed.parallel,
                  cardNumber: parsed.cardNumber,
                  isAuto: parsed.isAuto,
                  gradeCompany: null,
                  gradeValue: null,
                  price,
                  soldAt: new Date(soldAt).toISOString(),
                  source,
                  sourceExternalId: row.externalId ?? null,
                  title,
                  imageUrl: null,
                  sellerHandle: null,
                  sport,
                  verifiedByUser: false,
                  confidence: 0.3,
                },
                signal: { rollingMedian, ratio, note: `${ratio > 3 ? "high" : "low"}-outlier vs 30d median ($${rollingMedian.toFixed(2)}, n=${prices.length})` },
              });
              result.skipped++;
              continue;
            }
          }
        }
      } catch {
        // Detector failure is non-fatal — fall through and persist.
      }

      // CF-IMAGE-VERIFY-INGEST (Drew, 2026-07-28). If we have both an
      // ingest image URL AND a catalog reference with a pHash, compare
      // — mismatch (Hamming distance > threshold) routes to
      // verify_queue with reason="cross-source-mismatch". The comp
      // still persists — user gets the pricing signal AND the queue
      // gets a triage row so the ingest classification can be audited.
      // Feature-flagged: IMAGE_VERIFY_ENABLED (off by default until
      // catalog phash coverage lands).
      if (process.env.IMAGE_VERIFY_ENABLED === "true" && row.url && row.imageUrl) {
        try {
          const { getCatalogEntry } = await import("./cardCatalog.service.js");
          const catalogEntry = await getCatalogEntry(slug);
          const refPhash = catalogEntry?.referenceImage?.phash;
          if (refPhash) {
            const { computeImageHash, classifyImageMatch } = await import("./imageVerify.service.js");
            const ingestPhash = await computeImageHash(String(row.imageUrl));
            if (ingestPhash) {
              const classification = classifyImageMatch(refPhash, ingestPhash);
              if (classification.verdict === "mismatch") {
                const { enqueueForVerify } = await import("./verifyQueue.service.js");
                await enqueueForVerify({
                  reason: "image-mismatch",
                  saleInput: {
                    cardId: identity.vendorCardId ?? `hiq:${slug.slice(4)}`,
                    playerName,
                    cardYear,
                    setName: setKey,
                    parallel: parsed.parallel,
                    cardNumber: parsed.cardNumber,
                    isAuto: parsed.isAuto,
                    gradeCompany: null,
                    gradeValue: null,
                    price,
                    soldAt: new Date(soldAt).toISOString(),
                    source,
                    sourceExternalId: row.externalId ?? null,
                    title,
                    imageUrl: String(row.imageUrl),
                    sellerHandle: null,
                    sport,
                    verifiedByUser: false,
                    confidence: 0.3,
                  },
                  signal: {
                    note: `image mismatch vs catalog reference (distance=${classification.distance}, similarity=${classification.similarity?.toFixed(3)}) — probable classification error`,
                  },
                });
              }
            }
          }
        } catch {
          // Image-verify failures never block the persist path.
        }
      }

      const sourceExternalId = row.externalId
        ?? (row.url ? createHash("sha256").update(source + ":" + row.url).digest("hex").slice(0, 24)
                    : createHash("sha256").update(source + ":" + title + price + soldAt).digest("hex").slice(0, 24));
      // CF-GRADE-QUALIFIER (Drew, 2026-07-23, issue #713 phase 2):
      // opportunistically extract grade + qualifier from the title.
      // parseGradeLabel returns null on unparseable titles, which we
      // treat as "raw / grade unknown" — the sold_comps schema tolerates
      // null gradeCompany.
      let gradeParsed = parseGradeLabel(title);
      // CF-GRADE-TIER-RESOLVER (Drew, 2026-08-02). If the title didn't
      // carry a grade, ask the price-band resolver to pick the most
      // likely tier from historical sales of the same card. Stage 3.6b
      // of the Bayesian identity decoder. Only fires when
      // parseGradeLabel returned nothing — never overrides an explicit
      // title-parsed grade. When resolver returns raw (company=null),
      // gradeParsed stays null (raw is represented as gradeCompany:
      // null in sold_comps writes below).
      if (!gradeParsed) {
        const resolved = await resolveGradeTierByPrice({
          playerName,
          cardYear,
          cardNumber: parsed.cardNumber,
          parallel: parsed.parallel,
          price,
        });
        if (resolved && resolved.confidence >= 0.7 && resolved.gradeCompany && resolved.gradeValue !== null) {
          gradeParsed = {
            gradeCompany: resolved.gradeCompany,
            gradeValue: resolved.gradeValue,
          };
        }
      }
      // CF-PARALLEL-PRICE-ANOMALY (Drew, 2026-08-04). Sellers routinely
      // mis-label parallels (e.g., "Yellow Refractor" when the card is
      // actually a Yellow X-Fractor, which sells for ~half the price).
      // Ingesting them straight drags the true-parallel median down and
      // starves the actual-parallel pool. Detect: sale price
      // <60% of the declared-parallel median (with N>=5 in 90d) →
      // flag priceAnomaly=true so downstream FMV filters exclude the row.
      // Vision LLM re-check (Layer 2) is a follow-up.
      let priceAnomaly: {
        priceAnomaly: boolean;
        priceAnomalyReason?: string;
        expectedMedian?: number;
        deviation?: number;
        priceAnomalyCheckedAt: string;
      } = { priceAnomaly: false, priceAnomalyCheckedAt: new Date().toISOString() };
      if (process.env.PRICE_ANOMALY_DETECT_ENABLED === "true"
          && playerName && cardYear && parsed.parallel
          && parsed.parallel.toLowerCase() !== "base") {
        try {
          const anomalyContainer = container;
          const gCo = gradeParsed?.gradeCompany ?? null;
          const gVal = gradeParsed?.gradeValue ?? null;
          const cutoffIso = new Date(Date.now() - 90 * 86400_000).toISOString();
          const params: Array<{ name: string; value: string | number | boolean | null }> = [
            { name: "@p", value: playerName },
            { name: "@y", value: cardYear },
            { name: "@par", value: parsed.parallel },
            { name: "@isAuto", value: !!parsed.isAuto },
            { name: "@since", value: cutoffIso },
          ];
          let where = "c.playerName = @p AND c.cardYear = @y AND c.parallel = @par AND c.isAuto = @isAuto AND c.soldAt >= @since AND c.price > 0 AND (NOT IS_DEFINED(c.priceAnomaly) OR c.priceAnomaly != true)";
          if (gCo) { where += " AND c.gradeCompany = @gCo"; params.push({ name: "@gCo", value: gCo }); }
          if (gVal) { where += " AND c.gradeValue = @gVal"; params.push({ name: "@gVal", value: gVal }); }
          // Memoised per batch on the cohort's own identity — every sale
          // of the same player/year/parallel/grade asked for the same set.
          const cohortKey = [playerName, cardYear, parsed.parallel, !!parsed.isAuto, gCo ?? "", gVal ?? ""].join("|");
          let cohortPrices = anomalyCohortByKey.get(cohortKey);
          if (!cohortPrices) {
            const { resources: priceRows } = await anomalyContainer.items.query<{ price: number }>({
              query: `SELECT c.price FROM c WHERE ${where}`,
              parameters: params,
            }, { maxItemCount: 200 }).fetchAll();
            cohortPrices = (priceRows || []).map((r) => Number(r.price));
            anomalyCohortByKey.set(cohortKey, cohortPrices);
          }
          const prices = cohortPrices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
          if (prices.length >= 5) {
            const median = prices[Math.floor(prices.length / 2)];
            const deviation = median > 0 ? (median - price) / median : 0;
            // 40%+ below median for a parallel with 5+ recent comps is
            // suspicious. Real market moves rarely swing 40% overnight
            // on a mid-liquidity parallel.
            if (price < median * 0.6) {
              priceAnomaly = {
                priceAnomaly: true,
                priceAnomalyReason: "below-parallel-median",
                expectedMedian: Math.round(median * 100) / 100,
                deviation: Math.round(deviation * 1000) / 1000,
                priceAnomalyCheckedAt: new Date().toISOString(),
              };
              console.log(JSON.stringify({
                event: "price_anomaly_flagged",
                source: "persistVendorSalesToPool",
                slug, title,
                player: playerName, year: cardYear, parallel: parsed.parallel, grade: gCo && gVal ? `${gCo} ${gVal}` : null,
                salePrice: price, parallelMedian: median, deviationPct: (deviation * 100).toFixed(0),
                sampleSize: prices.length,
              }));
            }
          }
        } catch { /* anomaly detection is soft — never blocks the persist */ }
      }

      const doc = {
        id: `${source}::${sourceExternalId}`,
        // Prefer the vendor's real cardId when known (CH path) so the
        // vendor-cardId lookup finds these rows too. Fall back to the
        // hobbyiqCardId-derived pseudo-cardId (Cardsight-search path
        // where no stable cardId exists).
        cardId: identity.vendorCardId ?? `hiq:${slug.slice(4)}`,
        hobbyiqCardId: slug,
        contentHash,
        playerName,
        cardYear,
        setName: setKey,
        cardNumber: parsed.cardNumber,
        parallel: parsed.parallel,
        isAuto: parsed.isAuto,
        printRun: parsed.printRun,
        autoStyle: parsed.autoStyle,
        gradeCompany: gradeParsed?.gradeCompany ?? null,
        gradeValue: gradeParsed?.gradeValue ?? null,
        gradeQualifier: gradeParsed?.qualifier ?? null,
        price,
        soldAt: new Date(soldAt).toISOString(),
        source,
        sourceExternalId,
        title,
        url: row.url ?? null,
        // CF-INGEST-IMAGE-CAPTURE (Drew, 2026-08-08). row.imageUrl was
        // being used for staging mirror + pHash verify but dropped from
        // the pool doc — 100% of tca-ebay and cardsight sold_comps rows
        // landed without images despite the vendor sending them.
        // Preserving here fills images going forward at ~3,500/day for
        // TCA alone; historical rows still need a backfill pass.
        imageUrl: row.imageUrl ?? null,
        observedAt: new Date().toISOString(),
        sport,
        identityMethod,
        ...priceAnomaly,
      };
      // CF-INGEST-CLEANLINESS-GUARDRAIL (Drew, 2026-08-08). The write above
      // uses the normalizer's clean playerName + a hobbyiqCardId computed
      // from those clean fields, so this row lands in the CORRECT
      // canonical slug bucket. Fleet-level regressions in either the
      // normalizer OR the identity resolver are caught by the every-6h
      // `checkSoldCompsCleanliness.cjs` canary (see .github/workflows/
      // cleanliness-canary.yml). If you're adding new fields OR changing
      // slug computation here, extend the canary too so drift shows up
      // within 6h instead of after 3.9M rows accumulate.
      // CF-STAGING-CUTOVER (Drew, 2026-07-28). When cutover is on,
      // vendor ingest ONLY writes to comps_staging (the shim above
      // fires unconditionally). sold_comps writes come from the
      // promotion job that reads staging + applies verification
      // lineage. Legacy pool stays untouched — every new comp earns
      // its way in.
      //
      // Flag-gated so the cutover can be flipped without a redeploy
      // if the promotion job falls behind or a bug surfaces.
      if (process.env.COMPS_STAGING_CUTOVER_ENABLED === "true") {
        // Skip the direct sold_comps write. Staging shim already
        // fired above the dedup check, so the record is captured.
        result.skipped++;
        continue;
      }

      await container.items.upsert(doc);
      result.inserted++;
      // Staging shim runs earlier (above the dedup check) so it fires
      // regardless of whether sold_comps dedups the write. See
      // CF-COMPS-STAGING-SHIM-EARLY.

      // CF-CATALOG-MATCH-ONLY (Drew, 2026-08-08). The catalog auto-upsert
      // that used to fire here (both the original sales-derived:sha256
      // scheme and the later CF-CATALOG-KEYED-BY-HOBBYIQCARDID fix) has
      // been removed. Ingest MUST NOT grow the catalog. Bad vendor data
      // grew it into 1.86M sales-derived fragments that damaged trends
      // and FMV credibility. Catalog is now MATCH-only via
      // catalogHasSlug() upstream; unmatched slugs go to admin review.
      // If a real card is missing from the catalog, add it explicitly
      // via ingest-product-checklist / admin approval — not by silently
      // trusting vendor-title guesses.
    } catch (err) {
      console.warn(JSON.stringify({
        event: "persist_vendor_sales_error",
        source: "persistVendorSalesToPool",
        vendorSource: source,
        slug,
        error: (err as Error)?.message ?? String(err),
      }));
      result.skipped++;
    }
  }
  if (result.inserted > 0 || result.deduped > 0 || result.catalogUnmatched > 0) {
    console.log(JSON.stringify({
      event: "persist_vendor_sales",
      source: "persistVendorSalesToPool",
      vendorSource: source,
      inserted: result.inserted,
      deduped: result.deduped,
      skipped: result.skipped,
      catalogUnmatched: result.catalogUnmatched,
    }));
  }
  return result;
}

/** Fire-and-forget wrapper. Use this from vendor client wrappers so
 *  callers don't have to await persistence. Silences errors internally. */
export function persistVendorSalesInBackground(
  source: "cardsight" | "cardhedge" | "tca-ebay",
  rows: VendorSaleRow[],
  identity: VendorPersistIdentityHint = {},
): void {
  persistVendorSalesToPool(source, rows, identity).catch((err) => {
    console.warn(JSON.stringify({
      event: "persist_vendor_sales_background_error",
      source: "persistVendorSalesInBackground",
      error: (err as Error)?.message ?? String(err),
    }));
  });
}

/** Best-effort year extraction from a title. Recognizes leading 4-digit
 *  year (2015-2027 range). Returns null when nothing plausible found. */
function guessCardYearFromTitle(title: string): number | null {
  const m = title.match(/\b(20\d{2})\b/);
  if (m) {
    const y = Number(m[1]);
    if (y >= 2000 && y <= 2030) return y;
  }
  return null;
}

/** Best-effort player-name guess. Delegates to parseCardQuery — the
 *  same battle-tested free-text parser the search endpoint uses. Handles
 *  eBay-title conventions (leading year, trailing team, grade suffixes,
 *  set-name tokens like "Bowman Chrome" that could otherwise be
 *  mistaken for a player name).
 *
 *  CF-TCA-GUESS-PLAYER-REAL (Drew, 2026-08-02). Was a null-returning
 *  stub — CH ingest always passed playerName via identity hint, but
 *  TCA webhook rows come with player: null on 100% of rows (verified
 *  via batch_coverage diag: 0/1000 populated). That caused a 100% skip
 *  rate on webhook ingest. This implementation lets us extract player
 *  from titles like "2011 Topps Update Mike Trout Rookie #US175 PSA 10". */
function guessPlayerFromTitle(title: string): string | null {
  try {
    // Lazy require to avoid circular dep at module load.
    // parseCardQuery lives in compiq/ and imports from many places.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { parseCardQuery } = require("../compiq/cardQueryParser.js");
    const parsed = parseCardQuery(String(title || ""));
    const player = parsed?.playerName;
    return typeof player === "string" && player.trim().length > 0 ? player.trim() : null;
  } catch {
    return null;
  }
}

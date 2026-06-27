/**
 * Player+product comp aggregation, CH-only.
 *
 * Endpoint contract (see route in compiq.routes.ts):
 *   GET /api/compiq/comps-by-player?playerName=...&product=...&cardYear=...
 *     &parallel=...&gradeCompany=...&gradeValue=...
 *   →  CompsByPlayerResponse
 *
 * Flow (CF-CARDSIGHT-REMOVAL-PHASE-2):
 *   1. searchCards(player + product + year) on CardHedge — top-25 candidates.
 *   2. Filter to candidates whose year matches input.cardYear and whose set/title
 *      contains the product token. On empty, fall through to all candidates with a warning.
 *   3. For up to MAX_TRUSTED_PROBES candidates, call getTrustedComps(card_id, identity, grade).
 *      Trust-rejected results (blob_signature, no_real_data) are dropped silently — the
 *      gap propagates upward as fewer comps rather than as untrusted noise.
 *   4. Aggregate + dedupe on (title, date, price), sort by date desc.
 *
 * Cache: 6h aggregate TTL via cacheGet/cacheSet. Cache key v2 (vendor changed).
 * Lower layer: CH client's own cacheWrap on searchCards (4h) + getCardSales (12h)
 *              + getPricesByCard (4h).
 */

import { cacheGet, cacheSet } from "../shared/cache.service.js";
import {
  searchCards,
  getTrustedComps,
  type CardHedgeCard,
  type CardHedgeIdentity,
} from "./cardhedge.client.js";

const log = {
  info: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "compsByPlayer.service", ...fields })),
  warn: (event: string, fields: Record<string, unknown> = {}) =>
    console.warn(JSON.stringify({ event, source: "compsByPlayer.service", ...fields })),
};

// 6h matches CH cache TTLs so the aggregate doesn't outlive its underlying pricing data.
const AGGREGATE_TTL_SECONDS = 6 * 3600;

// Worst-case CH call fan-out per request: 1 searchCards + ≤8 × (1 getPricesByCard + 1 getCardSales).
const MAX_TRUSTED_PROBES = 8;

const SEARCH_LIMIT = 25;

export interface CompsByPlayerInput {
  playerName: string;
  product: string;
  cardYear?: number;
  parallel?: string;
  gradeCompany?: string;
  gradeValue?: string | number;
}

export interface CompByPlayer {
  cardId: string;
  price: number;
  date: string;
  title: string;
  source: "cardhedge";
}

export interface CompsByPlayerResponse {
  player: string;
  product: string;
  cardYear?: number;
  cardIds: string[];
  comps: CompByPlayer[];
  cached: boolean;
  /** ms since the cached entry was written; only set when cached=true. */
  cacheAge?: number;
  warnings: string[];
}

interface CachedEntry {
  cachedAt: number;
  player: string;
  product: string;
  cardYear?: number;
  cardIds: string[];
  comps: CompByPlayer[];
  warnings: string[];
}

function buildCacheKey(input: CompsByPlayerInput): string {
  // v2: vendor switched from Cardsight to CardHedge — bump to invalidate stale entries.
  return [
    "compsByPlayer:v2",
    input.playerName.toLowerCase().trim().replace(/\s+/g, " "),
    input.product.toLowerCase().trim().replace(/\s+/g, " "),
    String(input.cardYear ?? ""),
    (input.parallel ?? "").toLowerCase().trim(),
    (input.gradeCompany ?? "").toLowerCase().trim(),
    String(input.gradeValue ?? "").trim(),
  ].join("|");
}

function deriveGradeQuery(input: CompsByPlayerInput): string {
  // CH getTrustedComps takes a grade string ("Raw", "PSA 10", etc.).
  if (!input.gradeCompany || input.gradeValue === undefined) return "Raw";
  return `${String(input.gradeCompany).toUpperCase()} ${input.gradeValue}`.trim();
}

function extractSurname(playerName: string): string {
  const parts = playerName.trim().split(/\s+/);
  return parts[parts.length - 1] ?? playerName;
}

function candidateMatches(c: CardHedgeCard, input: CompsByPlayerInput): boolean {
  if (input.cardYear !== undefined) {
    const cYearNum = c.year !== undefined && c.year !== null ? Number(String(c.year)) : NaN;
    if (!Number.isFinite(cYearNum) || cYearNum !== input.cardYear) return false;
  }
  const productLc = input.product.toLowerCase().trim();
  if (!productLc) return true;
  const setLc = (c.set ?? "").toLowerCase();
  const titleLc = (c.title ?? "").toLowerCase();
  return setLc.includes(productLc) || titleLc.includes(productLc);
}

/**
 * Aggregate player+product comps from CardHedge. Returns a flat, deduped,
 * date-sorted CompByPlayer array spanning the top-K trusted candidates that
 * match the player+product+year combination.
 *
 * Failure handling: search miss returns empty comps + warnings (NOT cached);
 * per-candidate getTrustedComps errors are tolerated (skipped, logged as
 * warnings); trust-rejected results are dropped silently.
 */
export async function fetchCompsByPlayer(
  input: CompsByPlayerInput,
): Promise<CompsByPlayerResponse> {
  const cacheKey = buildCacheKey(input);

  // Cache hit path
  const cachedJson = await cacheGet(cacheKey);
  if (cachedJson !== null) {
    try {
      const cached = JSON.parse(cachedJson) as CachedEntry;
      const cacheAge = Date.now() - cached.cachedAt;
      log.info("aggregate_cache_hit", {
        cacheKey,
        cacheAgeMs: cacheAge,
        compsCount: cached.comps.length,
      });
      return {
        player: cached.player,
        product: cached.product,
        ...(cached.cardYear !== undefined ? { cardYear: cached.cardYear } : {}),
        cardIds: cached.cardIds,
        comps: cached.comps,
        cached: true,
        cacheAge,
        warnings: cached.warnings,
      };
    } catch {
      // Corrupt cache entry — fall through to recompute.
      log.warn("aggregate_cache_parse_failed", { cacheKey });
    }
  }

  // Cache miss path
  const start = Date.now();
  const warnings: string[] = [];

  const yearToken = input.cardYear !== undefined ? String(input.cardYear) : "";
  const query = [yearToken, input.playerName.trim(), input.product.trim()]
    .filter(Boolean)
    .join(" ");

  const searchResults = await searchCards(query, SEARCH_LIMIT);

  if (searchResults.length === 0) {
    warnings.push(`No CardHedge candidates for query "${query}".`);
    log.warn("aggregate_search_empty", {
      playerName: input.playerName,
      product: input.product,
      cardYear: input.cardYear ?? null,
      query,
    });
    // Don't cache empty results — transient upstream issues should not pin a 6h null entry.
    return {
      player: input.playerName,
      product: input.product,
      ...(input.cardYear !== undefined ? { cardYear: input.cardYear } : {}),
      cardIds: [],
      comps: [],
      cached: false,
      warnings,
    };
  }

  // Filter to candidates whose year + product match. Fall through to all
  // search results with a warning when the strict filter empties the pool —
  // mirrors prior compsByPlayer behavior for resilience against catalog drift.
  let candidates = searchResults.filter((c) => candidateMatches(c, input));
  if (candidates.length === 0) {
    warnings.push(
      `No CardHedge candidates matched ${input.playerName} ${input.product} ${yearToken} exactly — aggregating top-ranked results.`,
    );
    log.warn("aggregate_filter_no_match", {
      query,
      topCandidates: searchResults
        .slice(0, 3)
        .map((c) => `${c.year ?? "?"} ${c.set ?? ""} ${c.number ?? ""}`.trim())
        .join(" | "),
    });
    candidates = searchResults;
  }

  // Build identity for trust-guard. Surname + year scoping prevents the CH
  // "recent sales blob" fallback bucket from polluting our comp pool.
  const identity: CardHedgeIdentity = {
    playerSurname: extractSurname(input.playerName).toLowerCase(),
    expectedYear: yearToken,
  };
  const gradeQuery = deriveGradeQuery(input);

  // Top-K trusted-comp probe. Per-candidate failures + trust-rejections are tolerated.
  const probeSet = candidates.slice(0, MAX_TRUSTED_PROBES);
  const trustedResults = await Promise.all(
    probeSet.map((c) =>
      getTrustedComps(c.card_id, identity, gradeQuery).catch((err: any) => {
        log.warn("aggregate_trusted_probe_failed", {
          cardId: c.card_id,
          query,
          error: err?.message ?? String(err),
        });
        return null;
      }),
    ),
  );

  // Aggregate + dedupe. Same sale can appear under multiple cardIds; dedupe
  // on (title, date, price) to avoid double-counting.
  const cardIds: string[] = [];
  const comps: CompByPlayer[] = [];
  const seenSales = new Set<string>();
  let rejectedTrust = 0;
  for (let i = 0; i < probeSet.length; i++) {
    const candidate = probeSet[i];
    const trusted = trustedResults[i];
    if (!trusted) continue;
    if (!trusted.trusted) {
      rejectedTrust++;
      log.info("aggregate_trust_rejected", {
        cardId: candidate.card_id,
        reason: trusted.reason,
      });
      continue;
    }
    cardIds.push(candidate.card_id);

    for (const sale of trusted.comps) {
      const date = sale.date ?? "";
      const title = sale.title ?? "";
      const dedupKey = `${title}|${date}|${sale.price}`;
      if (seenSales.has(dedupKey)) continue;
      seenSales.add(dedupKey);
      comps.push({
        cardId: candidate.card_id,
        price: sale.price,
        date,
        title,
        source: "cardhedge",
      });
    }
  }

  // Sort by date desc; empty dates sink to the end.
  comps.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });

  // Cache only if we produced meaningful data (cardIds populated, even if
  // comps is empty due to grade filter — that's a valid cache entry).
  const entry: CachedEntry = {
    cachedAt: Date.now(),
    player: input.playerName,
    product: input.product,
    ...(input.cardYear !== undefined ? { cardYear: input.cardYear } : {}),
    cardIds,
    comps,
    warnings,
  };
  if (cardIds.length > 0) {
    await cacheSet(cacheKey, JSON.stringify(entry), AGGREGATE_TTL_SECONDS);
  }

  log.info("aggregate_cache_miss", {
    cacheKey,
    cardCount: cardIds.length,
    compsCount: comps.length,
    rejectedTrust,
    elapsedMs: Date.now() - start,
  });

  return {
    player: input.playerName,
    product: input.product,
    ...(input.cardYear !== undefined ? { cardYear: input.cardYear } : {}),
    cardIds,
    comps,
    cached: false,
    warnings,
  };
}

// ───── Cache warming at startup ──────────────────────────────────────────────
//
// 10 demo-relevant player+product+year targets. Serialized warming avoids
// the upstream rate-limit cascade that previously poisoned warm caches.
//
// Startup cost estimate: ~10 targets × ~5s cold-call each ≈ ~50s sequential.
// Warming is fire-and-forget (see server.ts startup chain); /api/health stays
// responsive immediately and uncached queries during the warming window pay
// the same cold-path latency they would without warming.

const CACHE_WARM_TARGETS: ReadonlyArray<
  Pick<CompsByPlayerInput, "playerName" | "product" | "cardYear">
> = [
  { playerName: "Mike Trout", cardYear: 2011, product: "Topps Update" },
  { playerName: "Aaron Judge", cardYear: 2017, product: "Topps Update" },
  { playerName: "Cody Bellinger", cardYear: 2017, product: "Topps Update" },
  { playerName: "Shohei Ohtani", cardYear: 2018, product: "Topps Update" },
  { playerName: "Ronald Acuna Jr", cardYear: 2018, product: "Topps Update" },
  { playerName: "Juan Soto", cardYear: 2018, product: "Topps Update" },
  { playerName: "Gleyber Torres", cardYear: 2018, product: "Topps Update" },
  { playerName: "Bobby Witt Jr", cardYear: 2022, product: "Topps Chrome Update" },
  { playerName: "Paul Skenes", cardYear: 2024, product: "Topps Chrome Update" },
  { playerName: "Caleb Bonemer", cardYear: 2024, product: "Bowman Draft Chrome" },
];

export async function warmCompsByPlayerCache(): Promise<void> {
  const start = Date.now();
  let primed = 0;
  let failed = 0;
  for (const target of CACHE_WARM_TARGETS) {
    try {
      const result = await fetchCompsByPlayer(target);
      if (result.cardIds.length > 0) primed++;
      else failed++;
    } catch (err: any) {
      failed++;
      log.warn("warm_target_failed", {
        target: target.playerName,
        product: target.product,
        cardYear: target.cardYear,
        error: err?.message ?? String(err),
      });
    }
  }
  log.info("compsByPlayer_cache_warmed", {
    primed,
    failed,
    targets: CACHE_WARM_TARGETS.length,
    elapsedMs: Date.now() - start,
  });
}

// Test-only internal accessors.
export const __compsByPlayerInternals = {
  buildCacheKey,
  AGGREGATE_TTL_SECONDS,
  MAX_TRUSTED_PROBES,
  CACHE_WARM_TARGETS,
};

/**
 * Phase 1 of MCP /predict rewire (Option B): backend grows a player+product
 * comp aggregation endpoint that MCP's compsLoader can call instead of
 * reading the fn-cardhedge-comps blob.
 *
 * Design: docs/phase0/mcp_rewire_design.md (61e2d5c) — specifically the
 * 2026-05-27 pre-implementation addendum which supersedes §5 + §10 for this
 * implementation. Key revisions from the original spec:
 *   - product is REQUIRED (Q1 finding: Cardsight catalog text-relevance buries
 *     Topps Update Base Sets when only player+year is given)
 *   - Search query reuses Phase 2 v2 pattern: `${playerName} ${releaseName}`
 *   - Two-layer cache (this layer = aggregate, 6h TTL; lower layer = Cardsight
 *     client's existing cacheWrap on getPricing/searchCatalog)
 *
 * Endpoint contract (see route in compiq.routes.ts):
 *   GET /api/compiq/comps-by-player?playerName=...&product=...&cardYear=...
 *     &parallel=...&gradeCompany=...&gradeValue=...
 *   →  CompsByPlayerResponse
 *
 * Reuses:
 *   - lookupReleaseName + applyCardNumberDisambiguation (cardsight.mapper)
 *   - searchCatalog + getPricing (cardsight.client, both already cacheWrap'd)
 *   - translateResponse (cardsight.translator, handles raw + graded paths)
 *   - cacheWrap pattern via cacheGet/cacheSet (cache.service, Redis-or-memory)
 */

import { cacheGet, cacheSet } from "../shared/cache.service.js";
import { searchCatalog, getPricing } from "./cardsight.client.js";
import { translateResponse } from "./cardsight.translator.js";
import {
  lookupReleaseName,
  applyCardNumberDisambiguation,
} from "./cardsight.mapper.js";

const log = {
  info: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "compsByPlayer.service", ...fields })),
  warn: (event: string, fields: Record<string, unknown> = {}) =>
    console.warn(JSON.stringify({ event, source: "compsByPlayer.service", ...fields })),
};

// 6h matches Cardsight cacheWrap PRICING_TTL_SEC so the aggregate doesn't
// outlive its underlying pricing data.
const AGGREGATE_TTL_SECONDS = 6 * 3600;

// Matches cardsight.mapper.MAX_PRICING_PROBES for symmetry. Worst-case
// Cardsight call fan-out per request: 1 searchCatalog + ≤8 getPricing.
const MAX_PRICING_PROBES = 8;

const SEARCH_TAKE = 25;

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
  source: "cardsight";
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
  return [
    "compsByPlayer:v1",
    input.playerName.toLowerCase().trim().replace(/\s+/g, " "),
    input.product.toLowerCase().trim().replace(/\s+/g, " "),
    String(input.cardYear ?? ""),
    (input.parallel ?? "").toLowerCase().trim(),
    (input.gradeCompany ?? "").toLowerCase().trim(),
    String(input.gradeValue ?? "").trim(),
  ].join("|");
}

/**
 * Aggregate player+product comps from Cardsight. Returns a flat, deduped,
 * date-sorted CardComp array spanning the top-K data-bearing candidates that
 * match the player+product+year combination.
 *
 * Failure handling: catalog miss returns empty comps + warnings (NOT cached);
 * per-candidate getPricing errors are tolerated (skipped, logged as warnings).
 * Aggregate-level errors propagate.
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

  // Player-level aggregation doesn't have cardNumber context, but call the
  // disambiguator anyway to preserve dispatch behavior if a future caller
  // passes a cardNumber.
  const effectiveProduct =
    applyCardNumberDisambiguation(input.product, undefined) ?? input.product;
  const releaseName = lookupReleaseName(effectiveProduct);
  if (!releaseName) {
    warnings.push(
      `Product "${input.product}" not in Cardsight release dictionary — searching by literal product string.`,
    );
  }

  const query = [input.playerName.trim(), releaseName ?? effectiveProduct]
    .filter(Boolean)
    .join(" ");

  const catalogResults = await searchCatalog(query, {
    year: input.cardYear,
    take: SEARCH_TAKE,
  });

  if (catalogResults.length === 0) {
    warnings.push(`No Cardsight catalog results for query "${query}".`);
    log.warn("aggregate_catalog_empty", {
      playerName: input.playerName,
      product: input.product,
      cardYear: input.cardYear ?? null,
      query,
    });
    // Don't cache empty catalog results — transient Cardsight issues should not
    // pin a 6h null entry.
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

  // Release-name filter (case-insensitive exact match), with same fall-through
  // semantics as resolveCardId.
  const expectedRelease = (releaseName ?? effectiveProduct).toLowerCase().trim();
  let candidates = catalogResults.filter(
    (r) => (r.releaseName ?? "").toLowerCase().trim() === expectedRelease,
  );
  if (candidates.length === 0) {
    // setName "Chrome" fallback (pre-merge confirmation finding, 2026-05-27).
    // Cardsight encodes some chrome variants in setName rather than
    // releaseName — Caleb Bonemer 2024 "Bowman Draft Chrome" returns 2 cards
    // both with releaseName="Bowman Draft": one Base Set (BD-31, not chrome)
    // and one Chrome Prospect Autograph (CPA-CBO, the chrome variant). Naive
    // top-K fall-through mixes them. When the user's product implies "chrome"
    // but releaseName exact-match returns nothing, narrow to candidates whose
    // setName contains "chrome" (case-insensitive). If that also yields
    // nothing, fall through to the all-top-K aggregator with a warning.
    if (/chrome/i.test(input.product)) {
      const chromeFiltered = catalogResults.filter((r) =>
        /chrome/i.test(r.setName ?? ""),
      );
      if (chromeFiltered.length > 0) {
        candidates = chromeFiltered;
        warnings.push(
          `No catalog candidates matched release "${expectedRelease}" exactly — narrowed by setName containing "Chrome" (${chromeFiltered.length} candidates).`,
        );
        log.info("aggregate_setname_chrome_fallback", {
          query,
          expectedRelease,
          chromeFilteredCount: chromeFiltered.length,
        });
      }
    }
    if (candidates.length === 0) {
      warnings.push(
        `No catalog candidates matched release "${expectedRelease}" — aggregating top-ranked results instead.`,
      );
      log.warn("aggregate_release_filter_no_match", {
        query,
        expectedRelease,
        topCandidates: catalogResults
          .slice(0, 3)
          .map((r) => r.releaseName ?? "")
          .join(" | "),
      });
      candidates = catalogResults;
    }
  }

  // Top-K parallel pricing probe. Failures per-candidate are tolerated.
  const probeSet = candidates.slice(0, MAX_PRICING_PROBES);
  const pricings = await Promise.all(
    probeSet.map((c) =>
      getPricing(c.id).catch((err: any) => {
        log.warn("aggregate_pricing_probe_failed", {
          cardId: c.id,
          query,
          error: err?.message ?? String(err),
        });
        return null;
      }),
    ),
  );

  // Aggregate + dedupe. Same sale can appear under multiple cardIds (e.g.,
  // duplicate catalog entries per logical card per defect #5 family); dedupe
  // on title+date+price to avoid double-counting.
  const cardIds: string[] = [];
  const comps: CompByPlayer[] = [];
  const seenSales = new Set<string>();
  for (let i = 0; i < probeSet.length; i++) {
    const candidate = probeSet[i];
    const pricing = pricings[i];
    if (!pricing) continue;
    cardIds.push(candidate.id);

    const translated = translateResponse(pricing, {
      gradeCompany: input.gradeCompany,
      gradeValue:
        input.gradeValue !== undefined ? String(input.gradeValue) : undefined,
    });

    for (const t of translated) {
      const dedupKey = `${t.title}|${t.soldDate}|${t.price}`;
      if (seenSales.has(dedupKey)) continue;
      seenSales.add(dedupKey);
      comps.push({
        cardId: candidate.id,
        price: t.price,
        date: t.soldDate,
        title: t.title,
        source: "cardsight",
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
// 10 demo-relevant player+product+year targets, matching the
// CACHE_WARM_TARGETS list in cardsight.mapper.ts but now keyed at the
// aggregate granularity. Serialized warming per defect #13 v2 — avoids the
// Cardsight rate-limit cascade that previously poisoned warm caches.
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
  MAX_PRICING_PROBES,
  CACHE_WARM_TARGETS,
};

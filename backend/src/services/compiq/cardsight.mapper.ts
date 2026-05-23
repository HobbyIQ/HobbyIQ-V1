/**
 * Cardsight ID resolver (mapper). Phase 1 of migration per ADR-cardsight-migration-2026-05-18.
 *
 * Translates CompIQ internal query inputs (product names, parallels, etc.) to
 * Cardsight catalog card IDs and parallel IDs using the Cardsight catalog API.
 *
 * Resolution strategy (post Phase 1 CH-removal-v2 fix, per
 * docs/phase0/ch_removal_v2_plan.md commit 8d6d769):
 *  1. Build combined query: `{playerName} {cardsightReleaseName}` using the release dictionary
 *  2. Call searchCatalog with year + segment=baseball
 *  3. Filter results by releaseName exact match (case-insensitive)
 *  4. NEW (defect #1): if cardNumber provided AND multiple candidates remain,
 *     fetch getCardDetail (parallel fanout, capped at MAX_DETAIL_PROBES) and
 *     narrow by detail.number match
 *  5. NEW (defect #5): if still multiple candidates, probe getPricing for top-3
 *     (parallel fanout) and pick highest meta.total_records — Cardsight catalog
 *     returns duplicate entries per logical card, some without pricing data;
 *     candidates[0] is unreliable
 *  6. If parallel requested, call getCardDetail to resolve parallelId
 *
 * Wrapped with an in-process LRU cache for resolved cardIds. See bottom of file.
 */

import { searchCatalog, getCardDetail, getPricing } from "./cardsight.client.js";
import type { CardsightCatalogResult } from "./cardsight.client.js";

const log = {
  info: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "cardsight.mapper", ...fields })),
  warn: (event: string, fields: Record<string, unknown> = {}) =>
    console.warn(JSON.stringify({ event, source: "cardsight.mapper", ...fields })),
};

export interface CompIQQueryInput {
  playerName: string;
  cardYear?: string | number;
  product?: string;
  parallel?: string;
  cardNumber?: string;
  gradeCompany?: string;
  gradeValue?: string;
}

export interface CardsightResolution {
  cardId: string | null;
  parallelId: string | null;
  matchConfidence: "exact" | "likely" | "none";
  warnings: string[];
}

const COMPIQ_TO_CARDSIGHT_RELEASES: Record<string, string> = {
  "topps chrome": "Topps Chrome",
  "topps chrome update": "Topps Chrome Update",
  // Phase 2 — covers Mike Trout 2011, Ohtani 2018, Judge 2017, Acuna 2018.
  // Cardsight catalog confirmed releaseName "Topps Update" via live probe
  // (docs/phase0/phase2_design.md Q1 addendum).
  "topps update": "Topps Update",
  // Phase 2 correction — flagship Bowman Chrome was previously mismapped to
  // "Bowman Draft Chrome". Cardsight has both releases distinct; the flagship
  // string should map to itself.
  "bowman chrome": "Bowman Chrome",
  "bowman draft": "Bowman Draft",
  "bowman draft chrome": "Bowman Draft Chrome",
  "panini prizm": "Panini Prizm",
  "donruss": "Donruss",
};

const CARDSIGHT_SET_PATTERNS: Record<string, RegExp> = {
  "Topps Chrome Base":             /^Base Set$/i,
  "Topps Chrome Refractor":        /^Refractor$/i,
  "Topps Chrome Prospect Auto":    /^Chrome Prospect Autograph/i,
};

// Selection algorithm tuning constants. Detail probes are cheap (no pricing
// data, just metadata); pricing probes are expensive (~9s p50 first-call).
// Bound fanout so worst-case latency stays under iOS's 60s timeout.
const MAX_DETAIL_PROBES = 5;
// Phase 2 v2 — raised from 3 to 8 per implementation finding. Cardsight catalog
// returns up to 16 candidates for some queries (e.g. Shohei Ohtani 2018 Topps
// Update returned 16, with data-bearing cardIds ranked at positions 4 and 10).
// The prior cap of 3 caused candidates[0] fallback for cards where the
// data-bearing entry was ranked deeper. Probe budget applies request-side
// only; results are cache-protected after the first call. See
// docs/phase0/phase2_design.md Implementation findings (2026-05-25).
const MAX_PRICING_PROBES = 8;

function lookupReleaseName(product: string): string | null {
  if (!product) return null;
  const normalized = product.toLowerCase().trim();
  return COMPIQ_TO_CARDSIGHT_RELEASES[normalized] ?? null;
}

// Phase 2 v2 defect #12 — cardNumber-pattern dispatch (resolves the 2020 Witt
// "Bowman Chrome Refractor BDC-1" regression from PR #114).
//
// When a user types "Bowman Chrome" but the cardNumber prefix indicates a
// Bowman Draft Chrome realm card (BDC-N prospects, CPA-XXX autographs, etc.),
// override the product so resolveCardId searches the broader Bowman Draft
// catalog space instead of flagship Bowman Chrome. The Phase 2 dictionary
// correction ("bowman chrome" → "Bowman Chrome") is semantically correct but
// surfaces wrong-card answers for these cardNumber-prefixed queries because
// flagship Bowman Chrome and Bowman Draft Chrome share player+year but use
// different setNames in Cardsight catalog.
//
// Verified cardNumber pattern coverage (2026-05-25, Cardsight catalog probe +
// hobby convention):
//   BDC-  Bowman Draft Chrome main prospects (e.g. 2020 Witt BDC-1)
//   BD-   Bowman Draft base
//   CPA-  Chrome Prospect Autographs (e.g. Bonemer CPA-CBO)
//   CDA-  Chrome Draft Autographs (verified in 2020 Bowman Draft probe)
//   BCRP- Bowman Chrome Rookie Prospects (rare variant)
//   BBPA- Bowman Black Prospect Autographs
//
// Explicitly NOT in the override (these are flagship Bowman Chrome, not BDC):
//   BCP-  Bowman Chrome Prospects (releaseName="Bowman Chrome", setName="Prospects")
//   BSP-  Bowman Sapphire Prospects (different release entirely)
const BOWMAN_DRAFT_CHROME_NUMBER_PATTERN = /^(BD-|BDC-|CPA-|CDA-|BCRP-|BBPA-)/i;

function applyCardNumberDisambiguation(
  product: string | undefined,
  cardNumber: string | undefined,
): string | undefined {
  if (!product || !cardNumber) return product;
  if (product.toLowerCase().trim() === "bowman chrome" &&
      BOWMAN_DRAFT_CHROME_NUMBER_PATTERN.test(cardNumber)) {
    log.info("release_fallback_cardnumber_dispatch", {
      originalProduct: product,
      cardNumber,
      resolvedProduct: "Bowman Draft Chrome",
      endpoint: "resolveCardId",
    });
    return "Bowman Draft Chrome";
  }
  return product;
}

function tokenizeParallel(name: string): string[] {
  return name
    .split(/[\s\-/]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

// Phase 2 v2 — defect #2 fix: exact set-equality on tokens (sorted-array
// equal), replacing the prior subset check.
//
// Prior behavior: `inputTokens.every(t => candidateTokens.includes(t))` treated
// the input as a subset of the candidate. This caused "Refractor" to falsely
// match "Chrome Blue Refractor" (and similar over-permissive matches), which
// then drove `Array.find()` to return whichever multi-word refractor parallel
// appeared first in detail.parallels[] — semantically wrong, and the
// downstream getPricing(cardId, {parallelId}) call would filter to a parallel
// the user never asked for, often returning zero records.
//
// New behavior: token sets must be exactly equal post-sort. "Refractor" only
// matches a parallel literally named "Refractor". "Blue Wave Refractor" only
// matches "Blue Wave Refractor" (also order-independent: "Refractor Blue
// Wave" matches the same — order in tokenized form is normalized out).
//
// Safety fallback: when no parallel matches strictly, parallelId stays null
// and getPricing is called without a parallel filter — returns the full
// pricing pool, downstream filtering can disambiguate.
function parallelMatches(input: string, candidate: string): boolean {
  const inputTokens = tokenizeParallel(input).sort();
  const candidateTokens = tokenizeParallel(candidate).sort();
  if (inputTokens.length !== candidateTokens.length) return false;
  return inputTokens.every((t, i) => t === candidateTokens[i]);
}

// ───── Internal: resolution worker (uncached) ────────────────────────────────

async function _resolveCardId(
  input: CompIQQueryInput,
): Promise<CardsightResolution> {
  const warnings: string[] = [];

  // Phase 2 v2 defect #12 — apply cardNumber-pattern dispatch BEFORE dictionary
  // lookup, so an input.product="Bowman Chrome" with input.cardNumber="BDC-1"
  // resolves through the Bowman Draft Chrome catalog path instead of flagship.
  // input.product is preserved for log/warning text (user-facing reflection of
  // what they actually typed); effectiveProduct drives catalog routing.
  const effectiveProduct = applyCardNumberDisambiguation(input.product, input.cardNumber);

  let releaseName: string | null = effectiveProduct ? lookupReleaseName(effectiveProduct) : null;
  if (effectiveProduct && !releaseName) {
    warnings.push(
      `Product "${input.product}" not in Cardsight release dictionary — searching by player name only.`,
    );
  }

  const queryParts = [input.playerName.trim()];
  if (releaseName) queryParts.push(releaseName);
  const query = queryParts.join(" ");

  const results = await searchCatalog(query, {
    year: input.cardYear,
    take: 25,
  });

  if (results.length === 0) {
    log.warn("catalog_zero_results", {
      query,
      playerName: input.playerName,
      product: input.product ?? null,
      cardYear: input.cardYear ?? null,
      endpoint: "resolveCardId",
    });
    warnings.push(`No Cardsight catalog results for query "${query}".`);
    return { cardId: null, parallelId: null, matchConfidence: "none", warnings };
  }

  let candidates: CardsightCatalogResult[] = results;

  // Release-name filter (case-insensitive exact match). Falls through to
  // effectiveProduct (post-dispatch) when the dictionary misses — gives
  // unmapped products a chance to still narrow against catalog's releaseName
  // field. Using effectiveProduct rather than input.product so the dispatch
  // also informs the post-fetch narrowing step, not just the dictionary lookup.
  if (effectiveProduct) {
    const expectedRelease = (releaseName ?? effectiveProduct).toLowerCase().trim();
    const exactMatch = results.filter(
      (r) => r.releaseName?.toLowerCase() === expectedRelease,
    );
    if (exactMatch.length > 0) {
      candidates = exactMatch;
    } else {
      log.warn("release_filter_no_exact_match", {
        query,
        expectedRelease,
        dictHit: releaseName !== null,
        topCandidates: results.slice(0, 3).map((r) => r.releaseName ?? "").join(" | "),
        endpoint: "resolveCardId",
      });
      warnings.push(`No candidates matched release "${expectedRelease}" — picking from top-ranked results.`);
    }
  }

  // Sub-pattern filter (existing CARDSIGHT_SET_PATTERNS).
  if (input.product) {
    const patternKey = Object.keys(CARDSIGHT_SET_PATTERNS).find((k) =>
      k.toLowerCase().includes(input.product!.toLowerCase()),
    );
    if (patternKey) {
      const pattern = CARDSIGHT_SET_PATTERNS[patternKey];
      const setFiltered = candidates.filter((r) => pattern.test(r.setName ?? ""));
      if (setFiltered.length > 0) candidates = setFiltered;
    }
  }

  // ───── Defect #1+#5 fix — number disambiguation + pricing-bearing selection ─

  // Step A: card-number disambiguation via detail probes (cheap; no pricing).
  // Only fires when cardNumber is provided AND multiple candidates survive
  // release filtering. Capped at MAX_DETAIL_PROBES parallel calls to bound
  // worst-case latency under the iOS 60s budget. If MAX_DETAIL_PROBES <
  // candidates.length, we probe only the top N by catalog relevance order.
  if (input.cardNumber && candidates.length > 1) {
    const probeSet = candidates.slice(0, MAX_DETAIL_PROBES);
    const expectedNumber = input.cardNumber.toLowerCase().trim();
    const details = await Promise.all(
      probeSet.map((c) =>
        getCardDetail(c.id).catch(() => null),
      ),
    );
    const byNumber = probeSet.filter((_c, i) => {
      const d = details[i];
      return d && !d.notFound && d.number?.toLowerCase().trim() === expectedNumber;
    });
    if (byNumber.length > 0) {
      candidates = byNumber;
      log.info("cardnumber_filter_matched", {
        cardNumber: input.cardNumber,
        candidatesAfter: candidates.length,
        candidatesProbed: probeSet.length,
      });
    } else if (probeSet.length === candidates.length) {
      // We probed every candidate and none matched the number — fall back to
      // pricing-probe selection on the original set rather than failing here.
      log.warn("cardnumber_filter_no_match", {
        cardNumber: input.cardNumber,
        candidatesProbed: probeSet.length,
      });
    } else {
      // Probed only top-N; cardNumber may match a non-probed candidate.
      // Fall back to pricing probe; don't claim failure.
      log.warn("cardnumber_filter_inconclusive", {
        cardNumber: input.cardNumber,
        candidatesProbed: probeSet.length,
        totalCandidates: candidates.length,
      });
    }
  }

  // Step B: single candidate? Done. Skip pricing probe.
  if (candidates.length === 1) {
    return resolveParallelOnCandidate(candidates[0], input, warnings, "exact");
  }

  // Step C: pricing-probe disambiguation (defect #5). Cardsight returns
  // duplicate catalog entries per logical card; some are namesake players or
  // combo cards; some have empty pricing. Probe top-K in parallel and pick
  // the highest meta.total_records. Bounded at MAX_PRICING_PROBES.
  const topK = candidates.slice(0, MAX_PRICING_PROBES);
  const pricings = await Promise.all(
    topK.map((c) => getPricing(c.id).catch(() => null)),
  );
  const scored = topK.map((c, i) => ({
    candidate: c,
    records: pricings[i]?.meta?.total_records ?? 0,
  }));
  scored.sort((a, b) => b.records - a.records);

  const dataBearingCount = scored.filter((s) => s.records > 0).length;

  if (dataBearingCount === 0) {
    log.warn("all_top_candidates_empty", {
      query,
      probedCount: topK.length,
      totalCandidates: candidates.length,
    });
    warnings.push(
      `${topK.length} top candidates all had zero pricing data — using top-ranked.`,
    );
    return resolveParallelOnCandidate(candidates[0], input, warnings, "likely");
  }

  if (dataBearingCount > 1) {
    log.info("multiple_data_bearing_candidates", {
      query,
      chosenId: scored[0].candidate.id,
      chosenRecords: scored[0].records,
      altId: scored[1].candidate.id,
      altRecords: scored[1].records,
    });
    warnings.push(
      `${dataBearingCount} candidates have pricing data; picked highest (${scored[0].records} records).`,
    );
  }

  return resolveParallelOnCandidate(scored[0].candidate, input, warnings, dataBearingCount === 1 ? "exact" : "likely");
}

async function resolveParallelOnCandidate(
  topCard: CardsightCatalogResult,
  input: CompIQQueryInput,
  warnings: string[],
  matchConfidence: "exact" | "likely",
): Promise<CardsightResolution> {
  let parallelId: string | null = null;
  if (input.parallel) {
    const detail = await getCardDetail(topCard.id);
    if (detail.notFound || !detail.parallels?.length) {
      log.warn("parallel_not_found", {
        cardId: topCard.id,
        requestedParallel: input.parallel,
        reason: detail.notFound ? "detail_not_found" : "no_parallels",
        endpoint: "resolveCardId",
      });
      warnings.push(
        `Could not load card detail for id=${topCard.id} to resolve parallel "${input.parallel}".`,
      );
    } else {
      const matched = detail.parallels.find((p) =>
        parallelMatches(input.parallel!, p.name),
      );
      if (matched) {
        parallelId = matched.id;
      } else {
        log.warn("parallel_not_found", {
          cardId: topCard.id,
          requestedParallel: input.parallel,
          availableParallelCount: detail.parallels.length,
          endpoint: "resolveCardId",
        });
        warnings.push(
          `Parallel "${input.parallel}" not found among ${detail.parallels.length} parallel(s) — returning cardId only.`,
        );
      }
    }
  }

  return {
    cardId: topCard.id,
    parallelId,
    matchConfidence,
    warnings,
  };
}

// ───── In-process LRU cache for resolveCardId results ────────────────────────
//
// MIGRATE TO REDIS WHEN: scaling to multiple App Service instances (cache
// misses across instances will negate the warming benefit), OR cache
// invalidation needs to be cross-process (e.g. a catalog correction workflow
// needs to expire stale cardId mappings without redeploying).
//
// Until then in-process is correct: Cardsight catalog drift is slow, the
// 7-day TTL absorbs that drift, and the warming step at server start ensures
// popular cards skip the cold-path on fresh containers.

const RESOLVE_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const RESOLVE_CACHE_MAX_ENTRIES = 5000;
const CACHE_STATS_LOG_INTERVAL_MS = 5 * 60 * 1000;
const CACHE_STATS_LOG_EVERY_N = 100;

interface CacheEntry { value: CardsightResolution; expiresAt: number; }
const _resolveCache = new Map<string, CacheEntry>();
const _cacheStats = { hits: 0, misses: 0, evictions: 0, lastLogAt: 0, totalRequests: 0 };

function buildCacheKey(input: CompIQQueryInput): string {
  return [
    input.playerName.trim().toLowerCase().replace(/\s+/g, " "),
    String(input.cardYear ?? ""),
    (input.product ?? "").toLowerCase().trim(),
    (input.parallel ?? "").toLowerCase().trim(),
    (input.cardNumber ?? "").toLowerCase().trim(),
    (input.gradeCompany ?? "").toLowerCase().trim(),
    String(input.gradeValue ?? ""),
  ].join("|");
}

function cacheGet(key: string): CardsightResolution | null {
  const entry = _resolveCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _resolveCache.delete(key);
    return null;
  }
  // LRU touch — Map preserves insertion order; delete + re-set moves entry
  // to the most-recently-used end.
  _resolveCache.delete(key);
  _resolveCache.set(key, entry);
  return entry.value;
}

function cacheSet(key: string, value: CardsightResolution): void {
  if (_resolveCache.has(key)) _resolveCache.delete(key);
  _resolveCache.set(key, { value, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
  while (_resolveCache.size > RESOLVE_CACHE_MAX_ENTRIES) {
    const oldestKey = _resolveCache.keys().next().value;
    if (oldestKey === undefined) break;
    _resolveCache.delete(oldestKey);
    _cacheStats.evictions++;
  }
}

function logCacheStatsThrottled(): void {
  _cacheStats.totalRequests++;
  const now = Date.now();
  const intervalElapsed = now - _cacheStats.lastLogAt >= CACHE_STATS_LOG_INTERVAL_MS;
  const countTrigger = _cacheStats.totalRequests % CACHE_STATS_LOG_EVERY_N === 0;
  if (!intervalElapsed && !countTrigger) return;
  const total = _cacheStats.hits + _cacheStats.misses;
  const hitRatePct = total > 0 ? Math.round((_cacheStats.hits / total) * 1000) / 10 : 0;
  log.info("resolveCardId_cache_stats", {
    hits: _cacheStats.hits,
    misses: _cacheStats.misses,
    evictions: _cacheStats.evictions,
    size: _resolveCache.size,
    hitRatePct,
  });
  _cacheStats.lastLogAt = now;
}

/**
 * Public entry — cache-wrapped resolveCardId.
 *
 * Cache misses run the full _resolveCardId pipeline (catalog → release filter
 * → cardNumber narrowing → pricing-probe disambiguation). Cache hits return
 * the prior resolution. Failures (cardId === null) are NOT cached so transient
 * issues don't get pinned for 7 days.
 */
export async function resolveCardId(
  input: CompIQQueryInput,
): Promise<CardsightResolution> {
  const key = buildCacheKey(input);
  const cached = cacheGet(key);
  if (cached) {
    _cacheStats.hits++;
    logCacheStatsThrottled();
    return cached;
  }
  _cacheStats.misses++;
  logCacheStatsThrottled();

  const result = await _resolveCardId(input);
  if (result.cardId !== null) {
    cacheSet(key, result);
  }
  return result;
}

// ───── Cache warming at server startup ───────────────────────────────────────
//
// Popular cards that surface in demos + DailyIQ watchlists. Without warming,
// the first iOS query on any of these pays the cold-path latency (single
// candidate ~9s, multi-candidate disambiguation ~18s). With warming, every
// post-startup user hit is a cache lookup.
//
// MAINTENANCE: update when the DailyIQ watchlist rotates or demo set
// changes. Telemetry (resolveCardId_cache_stats logs) guides re-prime
// cadence.

// Phase 2 v2 — cardNumber field REMOVED per defect #10 mitigation (warming API
// load reduction). The Option B cache-alignment approach from addendum 8a51dd5
// was found to (1) trip Cardsight rate limit due to cardNumber detail-probe
// fan-out × 10 parallel warming targets at startup (~80-90 calls), and (2) not
// actually align with /price + /estimate request keys anyway because those
// paths don't populate cardNumber in queryContext (typical iOS usage).
//
// Trade-off: /price-by-id with iOS displayLabels (which DO carry cardNumber via
// defect #11 threading) pays cold-path latency on first request per logical
// card, then the result is cached lazily by resolveCardId's LRU and subsequent
// requests hit the cache. /price + /estimate hit warming-cache immediately.
//
// Witt Jr product correction preserved from Phase 2: "Topps Chrome" → "Topps
// Chrome Update" (USC35 is in the Update set, not flagship Topps Chrome).
const CACHE_WARM_TARGETS: ReadonlyArray<CompIQQueryInput> = [
  // 2011 Topps Update — Mike Trout RC class (demo-critical)
  { playerName: "Mike Trout",      cardYear: 2011, product: "Topps Update" },
  // 2017-2018 Topps Update — modern superstar RCs (demo-critical)
  { playerName: "Aaron Judge",     cardYear: 2017, product: "Topps Update" },
  { playerName: "Cody Bellinger",  cardYear: 2017, product: "Topps Update" },
  { playerName: "Shohei Ohtani",   cardYear: 2018, product: "Topps Update" },
  { playerName: "Ronald Acuna Jr", cardYear: 2018, product: "Topps Update" },
  { playerName: "Juan Soto",       cardYear: 2018, product: "Topps Update" },
  { playerName: "Gleyber Torres",  cardYear: 2018, product: "Topps Update" },
  // Modern Topps Chrome Update
  { playerName: "Bobby Witt Jr",   cardYear: 2022, product: "Topps Chrome Update" },
  { playerName: "Paul Skenes",     cardYear: 2024, product: "Topps Chrome Update" },
  // DailyIQ-style Bowman Draft Chrome prospect
  { playerName: "Caleb Bonemer",   cardYear: 2024, product: "Bowman Draft Chrome" },
];

export async function warmResolveCardIdCache(): Promise<void> {
  const start = Date.now();
  let primed = 0;
  let failed = 0;
  await Promise.all(
    CACHE_WARM_TARGETS.map(async (target) => {
      try {
        const result = await resolveCardId(target);
        if (result.cardId) primed++;
        else failed++;
      } catch (err: any) {
        failed++;
        log.warn("warm_target_failed", {
          target: target.playerName,
          year: target.cardYear,
          product: target.product,
          error: err?.message ?? String(err),
        });
      }
    }),
  );
  log.info("resolveCardId_cache_warmed", {
    primed,
    failed,
    targets: CACHE_WARM_TARGETS.length,
    elapsedMs: Date.now() - start,
  });
}

// Test-only internal accessors.
export const __resolveCardIdInternals = {
  clearCache: (): void => {
    _resolveCache.clear();
    _cacheStats.hits = 0;
    _cacheStats.misses = 0;
    _cacheStats.evictions = 0;
    _cacheStats.totalRequests = 0;
    _cacheStats.lastLogAt = 0;
  },
  cacheSize: (): number => _resolveCache.size,
  cacheStats: () => ({ ..._cacheStats }),
  buildCacheKey,
};

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
// data-bearing entry was ranked deeper. Defect #13 v2 makes warming use the
// same cap (single source of truth) by serializing warming targets instead
// of throttling per-target probe count. See warmResolveCardIdCache below.
const MAX_PRICING_PROBES = 8;

// CF-CARDSIGHT-RESOLVER-COMPREHENSIVE Phase 3 (re-ship from 486775b reverted
// in f67f9d2): set-level parallels that have their own cardId in Cardsight
// catalog with a distinct long-form setName.
//
// When the user requests parallel="Tiffany" on a product like "Topps" or
// "Topps Traded" with a specific year, the resolver should target the
// dedicated Tiffany set's cardId rather than falling back to the base set's
// cardId via pricing-probe records-based selection. The base set has
// 10-100× more records, so greedy would always win — exactly opposite of
// what we want when the user asked for Tiffany.
//
// Phase 1 of this CF restored the release-filter's ability to narrow on
// setName (the field where Cardsight actually populates the long-form set
// string); these dictionary overrides return exactly that long-form value
// so the filter locks onto the Tiffany cardId before the pricing-probe step.
//
// Bounded scope: 14 entries enumerated via Cardsight catalog probes on
// 2026-05-27. No generalized variant-priority — that's deferred to a future
// CF when additional set-level parallel cases surface (Glossy, Holiday, etc.).
//
// Keyed by `${product.toLowerCase()}|${year}` for unambiguous lookup. Both
// "topps" and "topps traded" carry their own year keys to disambiguate the
// flagship vs supplemental sets.
const TIFFANY_RELEASE_OVERRIDES: Record<string, string> = {
  // 1984-1991 Topps flagship Tiffany (continuous)
  "topps|1984": "1984 Topps Tiffany Baseball",
  "topps|1985": "1985 Topps Tiffany Baseball",
  "topps|1986": "1986 Topps Tiffany Baseball",
  "topps|1987": "1987 Topps Tiffany Baseball",
  "topps|1988": "1988 Topps Tiffany Baseball",
  "topps|1989": "1989 Topps Tiffany Baseball",
  "topps|1990": "1990 Topps Tiffany Baseball",
  "topps|1991": "1991 Topps Tiffany Baseball",
  // Topps Traded Tiffany — gaps at 1984/85/88/90 per Cardsight catalog
  "topps traded|1986": "1986 Topps Traded Tiffany Baseball",
  "topps traded|1987": "1987 Topps Traded Tiffany Baseball",
  "topps traded|1989": "1989 Topps Traded Tiffany Baseball",
  "topps traded|1991": "1991 Topps Traded Tiffany Baseball",
  // Fleer Tiffany — 1996-1997 only
  "fleer|1996": "1996 Fleer Tiffany Baseball",
  "fleer|1997": "1997 Fleer Tiffany Baseball",
};

// Lookup the Cardsight setName/releaseName the resolver should search for.
// Base dictionary returns the canonical product line ("Topps Update",
// "Bowman Chrome", etc.). The optional parallel + year arguments enable
// set-level parallel overrides — when parallel="Tiffany" and the product/year
// pair matches an enumerated Tiffany set, returns the dedicated Tiffany
// long-form setName instead. Backward-compatible: calls with only `product`
// behave exactly as before.
export function lookupReleaseName(
  product: string,
  parallel?: string | null,
  year?: number | null,
): string | null {
  if (!product) return null;
  const productNorm = product.toLowerCase().trim();

  // Tiffany set-level parallel override. Only fires when caller supplies
  // parallel + year AND the product/year pair matches an enumerated Tiffany
  // set. Parallel match is loose (case-insensitive token compare) so
  // "TIFFANY", "Tiffany", " tiffany " all hit.
  if (parallel && year != null && Number.isFinite(year)) {
    const parallelNorm = String(parallel).toLowerCase().trim();
    if (parallelNorm === "tiffany") {
      const override = TIFFANY_RELEASE_OVERRIDES[`${productNorm}|${year}`];
      if (override) return override;
    }
  }

  return COMPIQ_TO_CARDSIGHT_RELEASES[productNorm] ?? null;
}

// CF-PLAYERNAME-NORMALIZATION (2026-05-26): iOS card-scan path
// concatenates set / parallel / status tokens into the playerName field
// for ~9 of the user's ~16 real holdings. Server-side read-path
// normalization strips known contamination patterns before Cardsight
// catalog lookup so the right card can be identified. Stored data is
// preserved unchanged; a separate workstream addresses the iOS source.
//
// Multi-stage strategy:
//   1. Strip known set/status prefix tokens (longest match first)
//   2. Strip explicit suffix tokens (longest match first)
//   3. Strip generic CHR PROS / CHR PROSPECT suffix patterns via regex
//   4. Hygiene: collapse whitespace, trim
//
// Conservative defaults — only patterns observed in production data are
// stripped. Adding new tokens is low-risk additive; loosening to
// pattern-based heuristics would create false-positive risk on
// legitimate player names.
const PLAYERNAME_PREFIX_TOKENS = [
  // Longer multi-token prefixes must come BEFORE their shorter
  // overlapping prefixes so longest match wins.
  "CHROME PROSPECT AUTOGRAPHS",
  "TRADED TIFFANY",
  "PROSPECT AUTOGRAPHS",
  "TRADED",
  "TIFFANY",
];

const PLAYERNAME_SUFFIX_TOKENS = [
  // Longer suffixes first.
  "WAL-MART BORDER",
  "TIFFANY",
];

// Generic suffix: any "CHR PROS ..." or "CHR PROSPECT ..." through end
// of string. Matches the parallel-code suffixes that vary in spacing /
// dashes ("CHR PROS - MINI DIA", "CHR PROSPECT AU- SHIM", etc.) without
// requiring an entry per code.
const PLAYERNAME_GENERIC_CODE_SUFFIX = /\bCHR\s+PROS(?:PECT)?\b.*$/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizePlayerName(name: string | null | undefined): string {
  if (!name) return "";
  let s = String(name).trim();
  if (!s) return "";

  // Stage 1 — strip known prefix tokens (longest first via list order).
  for (const prefix of PLAYERNAME_PREFIX_TOKENS) {
    const re = new RegExp(`^${escapeRegExp(prefix).replace(/\\\s\+/g, "\\s+")}\\s+`, "i");
    if (re.test(s)) {
      s = s.replace(re, "").trim();
      break;
    }
  }

  // Stage 2 — strip explicit suffix tokens (longest first).
  for (const suffix of PLAYERNAME_SUFFIX_TOKENS) {
    const re = new RegExp(`\\s+${escapeRegExp(suffix).replace(/\\\s\+/g, "\\s+")}\\s*$`, "i");
    if (re.test(s)) {
      s = s.replace(re, "").trim();
      break;
    }
  }

  // Stage 3 — strip generic CHR PROS / CHR PROSPECT suffix patterns.
  s = s.replace(PLAYERNAME_GENERIC_CODE_SUFFIX, "").trim();

  // Stage 4 — hygiene.
  s = s.replace(/\s+/g, " ").trim();

  return s;
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

export function applyCardNumberDisambiguation(
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
  // CF-CARDSIGHT-RESOLVER-COMPREHENSIVE (parallelMatches fix): Cardsight
  // catalogs some set-level parallels with a verbose wrapper around the
  // canonical parallel name (e.g. parallelName="Limited Edition (Tiffany)"
  // for the Tiffany Maddux 1987 Topps Traded RC). User input "TIFFANY"
  // would never satisfy strict-set-equality against ["limited", "edition",
  // "(tiffany)"], leaving parallelId null and getPricing returning the
  // mixed base+Tiffany comp pool.
  //
  // Strip parenthesized wrappers from the candidate before tokenizing so
  // "Limited Edition (Tiffany)" tokenizes the same as the user's "Tiffany".
  // Generalizes to other wrapper patterns ("Refractor (Gold)" → ["gold"]).
  // Preserves defect #2 strict-equality semantics for non-wrapped parallels
  // (Refractor ≠ Chrome Blue Refractor remains the contract).
  const wrapped = name.match(/\(([^)]+)\)/);
  const stripped = wrapped ? wrapped[1] : name;
  return stripped
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

  // CF-CARDSIGHT-RESOLVER-COMPREHENSIVE Phase 3: pass parallel + cardYear so
  // set-level parallel overrides (Tiffany) can return the long-form setName
  // for the dedicated Tiffany cardId.
  const yearForLookup =
    typeof input.cardYear === "number" ? input.cardYear : Number(input.cardYear);
  let releaseName: string | null = effectiveProduct
    ? lookupReleaseName(effectiveProduct, input.parallel ?? null, Number.isFinite(yearForLookup) ? yearForLookup : null)
    : null;
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
  //
  // CF-CARDSIGHT-RESOLVER-COMPREHENSIVE (Phase 1): Cardsight's /catalog/search
  // populates `setName` with the long-form set string (e.g. "1987 Topps Traded
  // Tiffany Baseball") while `releaseName` is undefined-or-shorter. For set-
  // level parallel dictionary overrides (Tiffany — Phase 3) that return the
  // long-form setName, the filter must check BOTH fields so the dictionary
  // override actually narrows. For base products that map to a short releaseName
  // string ("Topps Chrome"), neither field matches the short form, so the
  // filter still falls through to downstream pricing-probe greedy — preserves
  // existing behavior for the 21+ base cases in the cohort.
  if (effectiveProduct) {
    const expectedRelease = (releaseName ?? effectiveProduct).toLowerCase().trim();
    const exactMatch = results.filter((r) => {
      const releaseLower = r.releaseName?.toLowerCase();
      const setLower = r.setName?.toLowerCase();
      return releaseLower === expectedRelease || setLower === expectedRelease;
    });
    if (exactMatch.length > 0) {
      candidates = exactMatch;
    } else {
      log.warn("release_filter_no_exact_match", {
        query,
        expectedRelease,
        dictHit: releaseName !== null,
        topCandidates: results.slice(0, 3).map((r) =>
          `${r.releaseName ?? ""}|${r.setName ?? ""}`,
        ).join(" || "),
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
      // Defect #9: this is expected fallthrough behavior under cross-catalog
      // disagreement (CH and Cardsight have different card numbers for ~80%
      // of cards per the Phase 2 warming-target audit). Logged at info, not
      // warn, since downstream pricing-probe handles it correctly and the
      // event is structural noise rather than an error condition.
      log.info("cardnumber_filter_no_match", {
        cardNumber: input.cardNumber,
        candidatesProbed: probeSet.length,
      });
    } else {
      // Probed only top-N; cardNumber may match a non-probed candidate.
      // Fall back to pricing probe; don't claim failure.
      // Defect #9: same rationale as cardnumber_filter_no_match — info level.
      log.info("cardnumber_filter_inconclusive", {
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
  // Defect #13 v2 — serialize warming targets to eliminate the parallel
  // rate-limit cascade. Prior Promise.all + 10 targets × MAX_PRICING_PROBES=8
  // produced ~80 concurrent Cardsight calls at startup, tripping the rate
  // limit and poisoning the LRU with candidates[0] fallback resolutions.
  // The first defect #13 attempt (asymmetric cap: warming=3, request=8)
  // eliminated the cascade but regressed deep-catalog cards (Ohtani-shape:
  // data-bearing cardId ranked >3 in catalog order). Serializing instead
  // means one resolution at a time, full MAX_PRICING_PROBES=8 per target,
  // no rate-limit cascade, no Ohtani-shape trade-off.
  //
  // Startup cost: ~10s parallel → ~3-4 min sequential. Acceptable because
  // warmResolveCardIdCache is invoked fire-and-forget after app.listen
  // (server.ts) — /api/health is responsive immediately; users in the
  // warming window pay cold-path latency on uncached queries (same as if
  // warming hadn't run).
  for (const target of CACHE_WARM_TARGETS) {
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
  }
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

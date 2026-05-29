// CF-UNIFIED-SEARCH-AND-CERT v1 W3 — Cardsight catalog → CardIdentity adapter.
//
// Per design doc 23038d7 §2. Adapts the existing
// `searchCatalog(query, opts)` output (CardsightCatalogResult[]) into
// the canonical CardIdentity[] shape the unified search dispatcher
// returns to consumers.
//
// Three helpers exported:
//   - cardsightCatalogToCardIdentity   — per-result mapping
//   - detectAutoFromBlob               — autograph signal across all
//                                        Cardsight text fields
//   - buildCatalogTitle                — display-string builder
//
// The W3 dispatcher consumes `cardsightCatalogToCardIdentity` with a
// score from `rankCatalogHits`; the adapter itself is pure (no IO,
// no caching) so testing is just shape mapping.
//
// Year=0 is treated as missing (cardsight.client.ts `_notFoundDetail`
// uses 0 as the not-found sentinel; passing 0 through to CardIdentity
// would mislead consumers into rendering "0" as the card year).

import {
  getCardDetail,
  type CardsightCatalogResult,
  type CardsightCardDetail,
} from "../compiq/cardsight.client.js";
import { withConcurrencyResult } from "../shared/concurrency.js";
import type {
  CardIdentity,
  CardIdentityAttribution,
} from "../../types/cardIdentity.js";

// Detail-enrichment concurrency limit. Empirically derived from the
// cardsight-cert-investigation arc (~8 req/s observed on the Cardsight
// catalog endpoints). Stacks additively with `fetchWithRetry`'s
// exponential backoff in cardsight.client.ts:152-195 — the pool caps
// outbound rate, retry handles any upstream 429 that slips through.
// Revisit if production observation differs.
const DETAIL_ENRICHMENT_CONCURRENCY = 8;

// Autograph signal regexes. Lifted as-is from the legacy CardHedge
// pipeline at compiq.routes.ts:763-764 — the text patterns are
// vendor-agnostic (slab/release/title text uses the same English
// conventions across CardHedge, Cardsight, and any future source).
// Number-prefix regex catches Cardsight's per-set autograph subset
// codes (CPA = Chrome Prospect Autographs, CDA = Chrome Draft
// Autographs, BDPA = Bowman Draft Prospect Autographs, etc.).
const AUTO_TEXT_RE =
  /\b(auto|autograph|autographs|signature|signed)\b/i;
const AUTO_NUMBER_RE =
  /(^|[^a-z])(cpa|cda|bdpa|cra|cdra|prospect ?auto|1st\s*pa|pa-|-au\b|ap-|rap)/i;

/**
 * Detect autograph signal across all text fields on a Cardsight
 * catalog result. Pure function; no IO.
 *
 * The blob construction is intentionally permissive — `name`,
 * `number`, `releaseName`, `setName`, and `player` are all checked
 * because Cardsight's autograph signaling lives in different fields
 * for different sets (e.g. "Prospect Autographs" in releaseName for
 * Bowman Chrome, "CPA-" prefix in `number` for the same set,
 * "Autograph" in `name` for one-off inserts).
 */
export function detectAutoFromBlob(c: CardsightCatalogResult): boolean {
  const blob = [
    c.name ?? "",
    c.number ?? "",
    c.releaseName ?? "",
    c.setName ?? "",
    c.player ?? "",
  ].join(" ");
  return AUTO_TEXT_RE.test(blob) || AUTO_NUMBER_RE.test(blob);
}

/**
 * Display title for a Cardsight catalog candidate. Used by
 * ResultsView (free-text picker) and VerifyView (confirm-this-card)
 * so the user sees something readable rather than a UUID.
 *
 * Composition mirrors the legacy displayLabel at compiq.routes.ts:
 *   `${year} ${set/release} ${player} #${number}`
 *
 * Empty / missing fields are dropped silently — title remains
 * non-empty even when fields are sparse.
 */
export function buildCatalogTitle(c: CardsightCatalogResult): string {
  const parts: string[] = [];
  if (c.year && c.year > 0) parts.push(String(c.year));
  // Prefer releaseName when both are present — that's the year-set
  // composite (e.g. "Topps Chrome Update"), while setName is often
  // the short form ("Base Set") that adds little display value.
  if (c.releaseName) parts.push(c.releaseName);
  else if (c.setName) parts.push(c.setName);
  if (c.player) parts.push(c.player);
  if (c.number) parts.push(`#${c.number}`);
  const joined = parts.filter((p) => p.length > 0).join(" ");
  // Fallback to `name` when the structured fields produced nothing
  // useful (rare — Cardsight's catalog is generally well-populated).
  return joined.length > 0 ? joined : c.name || "Unknown card";
}

/**
 * Map a Cardsight catalog result + relevance score → CardIdentity.
 *
 * Attribution is "ranked" — confidence is the relevance score from
 * `rankCatalogHits`, NOT a cert-grader certainty.
 *
 * Catalog list does not carry parallel/variation/serial info; those
 * live on /catalog/cards/{id} detail (CardsightCardDetail). When
 * `detail` is supplied (per CF-UNIFIED-SEARCH-AND-CERT W5-Windows
 * dispatcher enrichment), the `parallels` array and `attributes`
 * are populated from it; when absent, those fields remain undefined
 * on the returned CardIdentity (cert-source candidates also leave
 * them undefined by design).
 *
 * Image data is intentionally NOT enriched here — Cardsight's
 * `get_card_image` is a separate per-card binary fetch with no URL
 * shortcut (empirically confirmed 2026-05-29 follow-up Appendix A2).
 * W5-iOS picker handles image fetch via the SDK / direct endpoint
 * with whichever mitigation strategy (lazy / top-N / cache) the
 * picker UX chooses.
 */
export function cardsightCatalogToCardIdentity(
  c: CardsightCatalogResult,
  rankingScore: number,
  detail?: CardsightCardDetail,
): CardIdentity {
  const attribution: CardIdentityAttribution = "ranked";
  // Year=0 is Cardsight's not-found sentinel; surface as null rather
  // than 0 to avoid rendering "0" in titles or year filters.
  const year = c.year && c.year > 0 ? c.year : null;

  return {
    candidateId: `cardsight:${c.id}`,
    source: "cardsight-catalog",
    attribution,
    confidence: rankingScore,

    player: c.player ?? c.name ?? null,
    year,
    brand: c.releaseName ?? null,
    setName: c.setName ?? null,
    cardNumber: c.number ?? null,
    parallel: null,
    variation: null,
    isAuto: detectAutoFromBlob(c),
    serialNumber: null,

    // Grade context is cert-only — null for catalog candidates.
    grade: null,
    gradeCompany: null,
    gradeValue: null,
    certNumber: null,
    totalPopulation: null,
    populationHigher: null,

    title: buildCatalogTitle(c),
    imageUrl: null,

    // Detail-enriched fields. Undefined when detail isn't supplied or
    // arrived as a notFound sentinel; populated otherwise.
    parallels: detail && !detail.notFound ? detail.parallels : undefined,
    attributes:
      detail && !detail.notFound
        ? (detail.attributes ?? [])
        : undefined,

    raw: c,
  };
}

/**
 * Enrich a ranked Cardsight catalog hit list with detail-endpoint data
 * (parallels[] + attributes[]) via concurrency-limited per-hit fetches.
 *
 * **Partial-failure semantics** (per CF-UNIFIED-SEARCH-AND-CERT W5-
 * Windows decision D1+D2): individual detail-fetch failures DO NOT
 * drop the hit from the response. Failed fetches surface as a single
 * aggregated `cardsight_detail_fetch_partial_failure` warn event for
 * grep-able post-deploy observability — per-fetch logs alone would
 * bury the signal in normal Cardsight chatter.
 *
 * Caching: each `getCardDetail` call already wraps `cacheWrap` with
 * key `cs:detail:{cardId}` TTL 24h (see cardsight.client.ts:285-289).
 * Warm-cache hits short-circuit at the client layer; the concurrency
 * pool here only spans actual cold fetches.
 *
 * Returns one `(hit, detail | undefined)` pair per input hit, in
 * input order. Caller passes both through to
 * `cardsightCatalogToCardIdentity(hit, score, detail)`.
 */
export async function enrichWithDetails(
  hits: CardsightCatalogResult[],
): Promise<Array<{ hit: CardsightCatalogResult; detail: CardsightCardDetail | undefined }>> {
  if (hits.length === 0) return [];
  const settled = await withConcurrencyResult(
    hits,
    DETAIL_ENRICHMENT_CONCURRENCY,
    async (hit) => getCardDetail(hit.id),
  );

  let failures = 0;
  const enriched = hits.map((hit, idx) => {
    const r = settled[idx];
    if (r.ok && !r.value.notFound) {
      return { hit, detail: r.value };
    }
    // r.ok=false (thrown) OR r.ok=true + notFound sentinel both leave
    // the candidate without parallels/attributes. The aggregated
    // partial-failure event below only counts thrown errors — those
    // are infrastructure-class signals (timeout, upstream 5xx).
    //
    // notFound from a search-returned cardId is a different signal:
    // Cardsight's search said the card exists, but its detail endpoint
    // says it doesn't. That's a data-consistency observation worth
    // logging discretely (info-level, distinct event name) so
    // post-deploy telemetry can grep for it. If it shows up, that's a
    // candidate for upstream-feedback follow-up.
    if (!r.ok) {
      failures += 1;
    } else if (r.value.notFound) {
      console.log(
        JSON.stringify({
          event: "cardsight_detail_notfound_from_search",
          source: "unifiedSearch.cardsightCatalogAdapter",
          cardId: hit.id,
        }),
      );
    }
    return { hit, detail: undefined };
  });

  if (failures > 0) {
    // Aggregated event per CF-PLAYERTRENDS-DUPLICATE-RECORDS
    // partial-failure pattern (b864af5) — grep-able discrete finding,
    // not buried in per-fetch noise.
    console.warn(
      JSON.stringify({
        event: "cardsight_detail_fetch_partial_failure",
        source: "unifiedSearch.cardsightCatalogAdapter",
        totalHits: hits.length,
        failures,
      }),
    );
  }

  return enriched;
}

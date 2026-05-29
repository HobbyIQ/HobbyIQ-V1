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

import type { CardsightCatalogResult } from "../compiq/cardsight.client.js";
import type {
  CardIdentity,
  CardIdentityAttribution,
} from "../../types/cardIdentity.js";

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
 * live on /catalog/cards/{id} detail (CardsightCardDetail). The
 * adapter sets them to null/false; downstream consumers fetch detail
 * via VerifyView's "load details" step when needed.
 */
export function cardsightCatalogToCardIdentity(
  c: CardsightCatalogResult,
  rankingScore: number,
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

    raw: c,
  };
}

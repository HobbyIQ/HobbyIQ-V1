/**
 * Comp routing layer (CardHedge-only).
 *
 * Post-CF-CARDSIGHT-REMOVAL (2026-06-28): Cardsight wholly decommissioned.
 * All comp fetching now goes through CardHedge via the trust-guard. The
 * file retains its historical name and exports vendor-neutral surfaces
 * (RoutedCard, RoutedSale, RoutedResult, findCompsRouted,
 * searchCardsRouted, getCardSalesRouted, getCardSalesRoutedWithProvenance)
 * so the pricing engine (compiqEstimate.service.ts) sees no signature
 * change.
 *
 * When CardHedge cannot bridge (no playerName, low confidence) or the
 * trust-guard rejects (blob signature, no real data), callers get an
 * empty RoutedResult. There is no Cardsight floor anymore.
 */

import {
  identifyCard as chIdentifyCard,
  searchCards as chSearchCards,
  getTrustedComps,
  type CardHedgeCard,
  type CardHedgeIdentity,
  type CardSearchFilters,
} from "./cardhedge.client.js";
import type { ParallelPriceSource, UserFacingPriceSource } from "./parallelTitleMatch.js";
import { cacheWrap, cacheGet, cacheSet } from "../shared/cache.service.js";
// CF-CARDSIGHT-FALLBACK-REVIVAL (Drew, 2026-07-14): targeted un-decommission
// for CH-catalog-miss cases. See cardsightFallback.ts for the rationale.
import { tryCardsightFallback } from "./cardsightFallback.js";
// CF-CS-STRUCTURED-BRIDGE (Drew, 2026-07-15): structured CS lookup that
// bypasses the fuzzy candidate-explode path when we have exact fields.
// Symmetric with cardHedgeStructuredBridge.
import { tryCardsightStructuredBridge } from "./cardsightStructuredBridge.js";
// CF-CS-PRICING-BACKSTOP (Drew, 2026-07-15): ultimate backstop when
// neither CH bridge nor CS catalog resolves the SKU. See
// cardsightPricingBackstop.ts for the rationale.
import { tryCardsightPricingBackstop } from "./cardsightPricingBackstop.js";
// CF-CH-STRUCTURED-BRIDGE (Drew, 2026-07-15): structured lookup path
// for holdings where we have exact fields (cardNumber). Skips CH's AI
// matcher entirely — cheaper + more precise. See file header.
import { structuredCardHedgeBridge } from "./cardHedgeStructuredBridge.js";
// CF-LOCAL-COMP-FIRST (Drew, 2026-07-17): our own-corpus comp branch.
// Reads ch_daily_sales (886k+ baseball rows) as an additional pool
// alongside CH+CS. Env-gated, defaults OFF.
import { lookupLocalComps } from "../portfolioiq/localCompStore.service.js";
import type { LocalCompSale } from "../../types/localComp.types.js";
// CF-CS-CATALOG-AUGMENT (Drew, 2026-07-21): supplement CH freetext
// search with CS catalog hits. CS carries product-lines that CH lags
// on (e.g. 2026 Bowman Sapphire not yet in CH). Merge + dedup at the
// router so all downstream callers get the wider result set.
import { searchCatalog as csSearchCatalog, type CardsightCatalogHit } from "./cardsightSlim.client.js";

// ── Bridge constants ────────────────────────────────────────────────────────
const BRIDGE_TTL_SEC = 24 * 3600;
const MIN_BRIDGE_CONFIDENCE = 0.80;

// ── Card-metadata side cache ──────────────────────────────────────────────────
// CF-PRICE-BY-ID-PLAYER-RESOLVE (2026-06-27): every RoutedCard surfaced via a
// search is stashed by card_id so the pinned /price-by-id path (which iOS
// deliberately calls with query=nil — see APIService.priceByCardId) can
// recover the real player/set/year/number/variant. Without this the pinned
// path only has the numeric card_id to work with, so cardIdentity.player
// degrades to the raw id AND the CardHedge comp bridge (which needs a
// playerName) can't resolve — yielding the "Can't estimate yet" empty state.
const CARD_META_TTL_SEC = 7 * 24 * 3600; // 7 days — outlives the 6h search cache.
function cardMetaKey(cardId: string): string {
  return `card-meta:${cardId}`;
}

export interface CardIdentityHint {
  playerName: string;
  cardYear?: string | number;
  product?: string;
  parallel?: string;
  /** Vestigial — was a Cardsight parallel UUID. CH bridge uses the parallel string only. */
  parallelId?: string;
  number?: string;
  isAuto?: boolean;
}

const log = {
  info: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "comp.router", ...fields })),
  warn: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "comp.router", level: "warn", ...fields })),
};

export interface RoutedCard {
  card_id: string;
  player?: string;
  set?: string;
  year?: number | string;
  number?: string;
  variant?: string;
  title?: string;
  name?: string;
  /** Front-facing card image (CardHedge CDN URL). Cached with the rest of
   *  the RoutedCard meta so the pinned /price-by-id hero can recover it. */
  imageUrl?: string;
}

export interface RoutedSale {
  price: number;
  date: string | null;
  grade: string;
  source: string;
  sale_type: string | null;
  title: string | null;
  url: string | null;
}

export type RoutedResult = {
  card: RoutedCard | null;
  sales: RoutedSale[];
  variantWarning: string[];
  aiCategory: string | null;
  /**
   * Vestigial parallel-match attribution. Always undefined in the
   * CH-only world (these fields were Cardsight pricing-shape signals).
   */
  priceSourceInternal?: ParallelPriceSource;
  priceSource?: UserFacingPriceSource;
  parallelMatchFilteredCount?: number;
  parallelMatchUnifiedCount?: number;
  chCardId?: string;
  chTrustReason?: "prices_by_card_honest" | "title_cohesion_strong";
};

export type QueryContext = {
  playerName?: string;
  cardYear?: string | number;
  product?: string;
  parallel?: string;
  parallelId?: string | null;
  cardNumber?: string;
  gradeCompany?: string;
  gradeValue?: string;
  isAuto?: boolean;
  pinnedAuthoritative?: boolean;
};

export type FindCompsRoutedOptions = {
  grade?: string;
  limit?: number;
  gradeCompany?: string;
  gradeValue?: string;
  queryContext?: QueryContext;
};

function emptyResult(warnings: string[] = []): RoutedResult {
  return {
    card: null,
    sales: [],
    variantWarning: warnings,
    aiCategory: null,
  };
}

/** CF-CS-CATALOG-AUGMENT (Drew, 2026-07-21). Map a Cardsight catalog
 *  hit onto the shared RoutedCard shape. CS carries product-line
 *  info in `releaseName` (e.g. "Bowman Sapphire") + `setName` (e.g.
 *  "Chrome Prospects Sapphire"); compose them for the display set.
 *  `player` is preferred, falls back to `name`. */
export function csCatalogHitToRoutedCard(c: CardsightCatalogHit): RoutedCard {
  const year = typeof c.year === "number" ? c.year : Number(c.year) || undefined;
  // CF-CS-COMPOSE-SET-DEDUP (Drew, 2026-07-21). Bidirectional substring
  // check so "Bowman Sapphire" + "Sapphire Selections" doesn't compose
  // to "Bowman Sapphire Sapphire Selections". Also strip if any token
  // in releaseName appears in setName (case-insensitive whole-word).
  const composedSet = (() => {
    const release = (c.releaseName ?? "").trim();
    const set = (c.setName ?? "").trim();
    if (!release && !set) return undefined;
    if (!release) return set;
    if (!set) return release;
    const releaseLc = release.toLowerCase();
    const setLc = set.toLowerCase();
    if (setLc.includes(releaseLc) || releaseLc.includes(setLc)) return set || release;
    // Drop from release any word that already appears in set.
    const setWords = new Set(setLc.split(/\s+/).filter(Boolean));
    const releaseTrimmed = release.split(/\s+/).filter(w => !setWords.has(w.toLowerCase())).join(" ").trim();
    return releaseTrimmed ? `${releaseTrimmed} ${set}` : set;
  })();
  const player = c.player ?? c.name ?? undefined;
  return {
    card_id: `cs:${c.id}`,
    player,
    set: composedSet,
    year,
    number: c.number || undefined,
    title: composedSet && player ? `${year ?? ""} ${composedSet} ${player}${c.number ? ` #${c.number}` : ""}`.trim() : c.name,
    name: c.name,
  };
}

/** Dedup key: canonicalize year+set+player+number+parallel so a CH row
 *  and a CS row for the same physical card collapse to one entry. */
function canonicalCardKey(c: RoutedCard): string {
  const norm = (s: string | undefined | number) =>
    String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return [
    norm(c.year),
    norm(c.set),
    norm(c.player),
    norm(c.number),
    norm(c.variant),
  ].join("|");
}

export function chCardToRoutedCard(c: CardHedgeCard): RoutedCard {
  return {
    card_id: c.card_id,
    player: c.player ?? undefined,
    set: c.set ?? undefined,
    year: c.year ?? undefined,
    number: c.number ?? undefined,
    variant: c.variant ?? undefined,
    title: c.title ?? c.name ?? undefined,
    name: c.name ?? undefined,
    imageUrl: c.image ?? undefined,
  };
}

/**
 * Build a CardHedge /v1/cards/card-match query from identity hint.
 * Matches the natural-language form CH's AI matcher ranks well on:
 *   "{year} {product} {playerName} {parallel} Autograph {number}"
 */
function buildCardHedgeQuery(identity: CardIdentityHint): string {
  const parts: string[] = [];
  if (identity.cardYear !== undefined && identity.cardYear !== null && identity.cardYear !== "") {
    parts.push(String(identity.cardYear));
  }
  if (identity.product) parts.push(identity.product);
  if (identity.playerName) parts.push(identity.playerName);
  if (identity.parallel) parts.push(identity.parallel);
  if (identity.isAuto) parts.push("Autograph");
  if (identity.number) parts.push(identity.number);
  return parts.join(" ").trim();
}

const GENERATIONAL_SUFFIX_RE = /^(jr|sr|ii|iii|iv)\.?$/i;

function extractSurname(playerName: string): string {
  if (!playerName) return "";
  const tokens = playerName.toLowerCase().trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  let idx = tokens.length - 1;
  while (idx > 0 && GENERATIONAL_SUFFIX_RE.test(tokens[idx])) idx--;
  return tokens[idx];
}

function identityCacheKey(query: string): string {
  // CF-CH-STRUCTURED-SEARCH-MERCY-CACHE-BUST (2026-07-01): bump key prefix
  // to invalidate the 24h-TTL "" empty-string entries cached BEFORE the
  // mercy fallback shipped in PR #226. Without this bump, queries whose
  // pre-#226 bridge_no_match / bridge_low_confidence result got cached
  // continue to short-circuit past the new mercy code for up to 24h.
  // Version tag scheme so future cache-invalidating changes are explicit.
  return ["router:ch-identify:v2", query.toLowerCase().replace(/\s+/g, " ").trim()].join(":");
}

// ── Structured-search mercy fallback ─────────────────────────────────────────
// CF-CH-STRUCTURED-SEARCH-MERCY (2026-07-01): CH's AI matcher rejects real
// cards it can't confidently identify (< MIN_BRIDGE_CONFIDENCE 0.80).
// Evidence: prod probe on 2026-07-01 hit Ethan Conrad Blue Refractor Auto
// — /card-match returned null with candidates_evaluated=10; /card-search
// returned the card as result #3. Once bridged, CH had 1 price in 90d,
// so PR #224's trust window would accept it. The gap is the bridge.
//
// Fallback logic: when card-match returns null OR low confidence, AND the
// parsed identity has BOTH playerName AND parallel, retry via structured
// /card-search filtered by player. Then pick the CH card whose title
// contains the parsed parallel as an EXACT adjacent-token match AND is not
// preceded by a color-qualifier token that would indicate a sibling
// parallel (e.g. "Sky Blue Refractor" is rejected when parsed parallel is
// "Blue Refractor"). If exactly one card wins, use it.
//
// Gated by CH_STRUCTURED_MERCY_ENABLED env (default "true"). Rollback lever:
// set to "false" on App Service.

const COLOR_QUALIFIERS = new Set([
  // Colors that could combine to form a distinct sibling parallel.
  "sky", "royal", "ice", "dark", "neon",
  "gold", "red", "orange", "purple", "pink", "green", "blue", "yellow",
  "black", "white", "silver", "platinum", "aqua", "cyan",
  // Non-color qualifiers that combine similarly.
  "geometric", "mojo", "cracked", "shimmer", "wave", "raywave", "lava",
  "atomic", "superfractor",
]);

/**
 * Given a set of CardHedge card-search results and the parsed parallel
 * string, return the single card whose title matches the parallel exactly
 * — or null if zero / multiple / ambiguous.
 *
 * When `opts.isAuto === true`, only cards whose subset field contains
 * "auto" (case-insensitive: "Prospect Autographs", "Chrome Prospect
 * Autograph", "Prospect Retail Autograph", "Prospect Mega Autographs
 * Chrome") are considered. When `opts.isAuto === false`, only cards
 * whose subset does NOT contain "auto" are considered. When `opts.isAuto`
 * is undefined, no subset filter applies (backward-compatible).
 *
 * The subset gate closes CF-CH-STRUCTURED-SEARCH-MERCY's false-match
 * hole: pre-fix, a query for "Blue Refractor Auto" on a card CH didn't
 * catalog as an auto would match the base-set Blue Refractor card and
 * price the wrong SKU (observed on Ethan Conrad 2026-07-01: $67 base
 * matched instead of the ~$400 auto Drew was looking for).
 *
 * Pure function. Exported for direct pin testing.
 */
export function pickBestByParallel(
  cards: CardHedgeCard[],
  parallel: string,
  opts?: { isAuto?: boolean },
): CardHedgeCard | null {
  if (!parallel) return null;
  const parallelTokens = parallel.toLowerCase().split(/\s+/).filter(Boolean);
  if (parallelTokens.length === 0) return null;

  // Auto/non-auto subset filter — see JSDoc above.
  const filtered = opts?.isAuto === undefined
    ? cards
    : cards.filter((c) => {
        const subsetLc = (c.subset ?? "").toLowerCase();
        const hasAuto = subsetLc.includes("auto");
        return opts.isAuto === true ? hasAuto : !hasAuto;
      });

  const matches: { card: CardHedgeCard; extraTokens: number }[] = [];
  for (const c of filtered) {
    const title = (c.title ?? "").toLowerCase();
    if (!title) continue;

    const tokens = title.split(/\s+/).filter(Boolean);
    // Find the parallel tokens appearing in adjacent order.
    let matchIdx = -1;
    for (let i = 0; i <= tokens.length - parallelTokens.length; i++) {
      let ok = true;
      for (let j = 0; j < parallelTokens.length; j++) {
        if (tokens[i + j] !== parallelTokens[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        matchIdx = i;
        break;
      }
    }
    if (matchIdx < 0) continue;

    // Reject if the token IMMEDIATELY preceding the parallel is a color/
    // qualifier — that indicates a sibling parallel (e.g. "sky blue refractor"
    // when parsed is "blue refractor").
    if (matchIdx > 0 && COLOR_QUALIFIERS.has(tokens[matchIdx - 1])) {
      continue;
    }

    matches.push({ card: c, extraTokens: tokens.length - parallelTokens.length });
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => a.extraTokens - b.extraTokens);
  // If top is meaningfully cleaner than second, pick top. Ties (< 1 token
  // difference) are ambiguous — return null.
  if (matches.length === 1 || matches[0].extraTokens < matches[1].extraTokens) {
    return matches[0].card;
  }
  return null;
}

/** Env-gated mercy fallback. Default on; rollback via CH_STRUCTURED_MERCY_ENABLED="false". */
function isMercyEnabled(): boolean {
  return String(process.env.CH_STRUCTURED_MERCY_ENABLED ?? "true").toLowerCase() !== "false";
}

/**
 * CF-CH-BRIDGE-VARIANT-GUARD (Drew, 2026-07-14, PR-B): normalize a parallel
 * string for cross-variant collision. Mirrors normalizeParallelForDedup in
 * unifiedSearch/dispatcher — same rules, inlined here to keep this file free
 * of a cross-service import.
 */
export function normalizeParallelForVariantGuard(parallel: string | null | undefined): string {
  if (!parallel) return "";
  return parallel
    .toLowerCase()
    .replace(/[-_/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * CF-CH-BRIDGE-VARIANT-GUARD (Drew, 2026-07-14, PR-B): decide whether a CH
 * AI-matcher result is a variant-honest match for the requested identity.
 *
 * PROBLEM: CH's /cards/card-match returns a card_id even when the closest
 * catalog SKU differs from the user's intended parallel — e.g. the user asks
 * for Hartman CPA-EHA Blue Refractor Auto (real card, ~$1800) but CH's
 * catalog has ZERO "Blue Refractor" under CPA-EHA. CH's AI picks the nearest
 * variant (CPA-EHA Blue X-Fractor or CPA-EHA Refractor) or the closest card
 * number (BCP-102 Blue Refractor, a NON-auto base card). Either way, the
 * bridge pins the wrong card_id and downstream comps come from the wrong
 * sub-market (Drew saw ~$420 instead of $1800).
 *
 * GUARD: when the identity carries both a parallel AND a match includes a
 * variant, both must normalize to the same string OR one must be a strict
 * substring of the other (allows CH's "Refractor" to accept when user only
 * said "Refractor" — but rejects when user said "Blue Refractor" and CH
 * returned "Refractor"). Same for card_number: if identity.number is set
 * and match.number differs case-insensitively, reject.
 *
 * Returns { ok: true } when the match honors the identity's variant
 * signals; { ok: false, reason } otherwise. Callers should treat !ok as
 * "no match" and fall through to structured mercy fallback (which uses
 * pickBestByParallel — variant-aware — and returns null when nothing fits).
 */
export function matchHonorsIdentity(
  match: {
    card_id?: string | null;
    variant?: string | null;
    number?: string | null;
    title?: string | null;
    set?: string | null;
  } | null,
  identity: { parallel?: string | null; number?: string | null; isAuto?: boolean },
  rawQuery?: string,
): { ok: true } | { ok: false; reason: "card_number_mismatch" | "parallel_mismatch" | "auto_vs_base_mismatch"; wanted: string; got: string } {
  if (!match) return { ok: true };  // no match to guard against

  // CF-AUTO-VARIANT-GUARD (Drew, 2026-07-15): reject when user asked for
  // an AUTOGRAPH but CH's match is a base card. Live evidence: Bobby
  // Witt Jr 2020 Bowman Chrome Auto — CH's AI matcher resolved to the
  // BASE card (auto is a separate SKU), engine happily priced with the
  // base's thousands of $10 sales instead of the auto's rare $1000+
  // sales, and the existing parallel/number guards had nothing to
  // reject with because identity.parallel was null.
  //
  // The check: identity says AUTO, but match's variant + title + set
  // contain no auto/autograph/RC-auto token → reject as auto_vs_base.
  if (identity.isAuto === true) {
    const matchBlob = [
      match.variant ?? "",
      match.title ?? "",
      match.set ?? "",
      match.number ?? "",
    ].join(" ").toLowerCase().trim();
    // Absence of metadata isn't evidence of base — only reject when we
    // have ACTUAL data on the match AND none of it signals auto. This
    // protects test fixtures that only stub card_id + confidence from
    // spurious rejections.
    if (matchBlob.length > 0) {
      const hasAuto = /\bauto(graph(ed)?)?\b/.test(matchBlob) || /\brpa\b/.test(matchBlob);
      // CardHedge's auto SKUs also carry the "Autograph" subset tag or a
      // CPA-/BCPA-/BDPA-/CPAR- style card number prefix.
      const hasAutoNumberPrefix = /^(CPA|BCPA|BCDA|BDPA|BDA|BPA|BCRA|TCRA|TRA|FCA|USA-|AU-)/i.test(
        String(match.number ?? "").trim(),
      );
      if (!hasAuto && !hasAutoNumberPrefix) {
        return {
          ok: false,
          reason: "auto_vs_base_mismatch",
          wanted: "autograph",
          got: `base (${match.variant ?? "no-variant"} / ${match.number ?? "no-num"})`,
        };
      }
    }
  }

  // CF-VARIANT-GUARD-SUPERSET (Drew, 2026-07-15): query-aware superset
  // acceptance. When our identity is a proper subset of CH's returned
  // parallel/number (e.g. identity.parallel="Refractor", match.variant=
  // "Reptilian Refractor"), the STRICT-equality guard used to reject
  // as parallel_mismatch. But CH's more-specific match is usually
  // CORRECT — our parser just under-specified. When the rawQuery text
  // contains CH's extra tokens ("reptilian" appears in the user's
  // query), accept the superset match. When it doesn't, the guard's
  // original wrong-SKU protection still fires.
  //
  // Same fix pattern as PR #457 (CS scoreCandidate). Both guard the
  // same class of parser-under-specification bug.
  const queryLower = (rawQuery ?? "").toLowerCase();

  // Card number guard — cheap and definitive. Superset acceptance
  // applies here too: identity.number="X-FRACTOR" (parser bug) vs
  // match.number="CPA-OC" is a real conflict, BUT if the parser
  // parsed the parallel as the cardNumber (a real bug we've seen),
  // and the query has the parallel text, we can also accept when
  // match.number appears in the query.
  if (identity.number && match.number) {
    const wantNum = String(identity.number).toLowerCase().trim();
    const gotNum = String(match.number).toLowerCase().trim();
    if (wantNum && gotNum && wantNum !== gotNum) {
      // Superset guard: match.number appears in the raw query text
      // (independent evidence CH's number is what the user meant).
      if (queryLower && queryLower.includes(gotNum)) {
        // Accept — CH's number is corroborated by the query text.
      } else {
        return { ok: false, reason: "card_number_mismatch", wanted: wantNum, got: gotNum };
      }
    }
  }
  if (identity.parallel && match.variant) {
    const want = normalizeParallelForVariantGuard(identity.parallel);
    const got = normalizeParallelForVariantGuard(match.variant);
    if (want && got && want !== got) {
      // Superset acceptance: identity's parallel is a substring of CH's
      // match variant, AND the extra tokens appear in the raw query.
      // Example: identity="refractor", match="reptilian refractor",
      // query has "reptilian" — accept (parser under-specified, query
      // corroborates).
      if (queryLower && got.includes(want)) {
        const wantTokens = new Set(want.split(/\s+/).filter((t) => t.length > 0));
        const extraTokens = got.split(/\s+/).filter((t) => t.length > 0 && !wantTokens.has(t));
        const allExtrasInQuery = extraTokens.every((t) => queryLower.includes(t));
        if (allExtrasInQuery) {
          // Accept the superset match. The parser lost tokens the user
          // clearly asked for; CH restored them.
        } else {
          return { ok: false, reason: "parallel_mismatch", wanted: want, got };
        }
      } else {
        return { ok: false, reason: "parallel_mismatch", wanted: want, got };
      }
    }
  }
  return { ok: true };
}

/**
 * Structured-search mercy fallback. Only fires when identity has both
 * playerName and parallel. Returns a card_id + synthetic confidence
 * (0.75 — below the AI matcher's 0.80 threshold but above zero) or null.
 */
async function structuredMercyFallback(
  identity: CardIdentityHint,
): Promise<{ chCardId: string; confidence: number } | null> {
  if (!isMercyEnabled()) return null;
  if (!identity.playerName || !identity.parallel) return null;

  const searchQuery = `${identity.playerName} ${identity.parallel}`.trim();
  try {
    const results = await chSearchCards(searchQuery, 10, { player: identity.playerName });
    if (!results.length) return null;
    const rescued = pickBestByParallel(results, identity.parallel, { isAuto: identity.isAuto });
    if (!rescued) return null;
    return { chCardId: rescued.card_id, confidence: 0.75 };
  } catch (err) {
    log.warn("router.mercy_fallback_error", {
      error: err instanceof Error ? err.message : String(err),
      player: identity.playerName,
      parallel: identity.parallel,
    });
    return null;
  }
}

/**
 * Resolve an identity hint to a CardHedge card_id via /v1/cards/card-match.
 * Cached 24h on the natural-language query. Returns null on no match or
 * confidence below MIN_BRIDGE_CONFIDENCE.
 *
 * CF-CH-RAW-QUERY (Drew, 2026-07-15): when `rawQuery` is passed AND the
 * env flag CH_USE_RAW_QUERY=true, we send the user's ORIGINAL free-text
 * to CH's AI matcher instead of the buildCardHedgeQuery reconstruction.
 * Rationale (from feedback_raw_query_to_ai_matcher memory): the whole
 * point of an AI matcher is to be FUZZY. Users type "hartman blue" or
 * "trout auto" — the AI is designed for that. Our parser is over-eager
 * (splits "Reptilian Refractor" into player+parallel, treats "X-Fractor"
 * as cardNumber, strips "Speckle" from "Speckle Refractor" — 4 real
 * Drew holdings broken 2026-07-15). When we reconstruct a rigid string
 * from broken tokens, we're feeding the AI our parser's bugs.
 *
 * The identity hint is still passed downstream to the variant guard
 * (which knows to reject wrong SKUs) and the structured mercy fallback.
 */
async function resolveChCardId(
  identity: CardIdentityHint,
  rawQuery?: string,
): Promise<{ chCardId: string; confidence: number } | null> {
  const useRawQuery =
    process.env.CH_USE_RAW_QUERY === "true" &&
    typeof rawQuery === "string" &&
    rawQuery.trim().length >= 3;
  const query = useRawQuery ? rawQuery!.trim() : buildCardHedgeQuery(identity);
  if (!query) return null;

  const raw = await cacheWrap(
    identityCacheKey(query),
    async () => {
      const match = await chIdentifyCard(query);
      if (!match || !match.card_id) {
        // CF-CH-STRUCTURED-BRIDGE (Drew, 2026-07-15): tier-1.5 rescue
        // using CH's /card-search endpoint filtered by player + local
        // cardNumber match. Runs BEFORE structured mercy because it's
        // more precise (cardNumber-anchored) — env-gated so it can be
        // rolled out independently.
        const structuredHit = await structuredCardHedgeBridge(identity);
        if (structuredHit) {
          log.info("router.bridge_rescued_via_ch_structured", {
            chCardId: structuredHit.chCardId,
            player: identity.playerName,
            number: identity.number,
            reason: "ai_matcher_returned_null",
          });
          return JSON.stringify(structuredHit);
        }
        // CF-CH-STRUCTURED-SEARCH-MERCY: try structured search rescue
        // before conceding bridge_no_match.
        const rescued = await structuredMercyFallback(identity);
        if (rescued) {
          log.info("router.bridge_rescued_via_structured", {
            chCardId: rescued.chCardId,
            player: identity.playerName,
            parallel: identity.parallel,
            reason: "ai_matcher_returned_null",
          });
          return JSON.stringify(rescued);
        }
        log.info("router.bridge_no_match", { query });
        return "";
      }
      if (match.confidence < MIN_BRIDGE_CONFIDENCE) {
        // CF-CH-STRUCTURED-BRIDGE (Drew, 2026-07-15): also try structured
        // bridge on below-threshold — often it's more confident than a
        // shaky AI match when we have cardNumber.
        const structuredHit = await structuredCardHedgeBridge(identity);
        if (structuredHit) {
          log.info("router.bridge_rescued_via_ch_structured", {
            chCardId: structuredHit.chCardId,
            player: identity.playerName,
            number: identity.number,
            reason: "ai_matcher_below_threshold",
            originalConfidence: match.confidence,
          });
          return JSON.stringify(structuredHit);
        }
        // CF-CH-STRUCTURED-SEARCH-MERCY: try structured rescue on
        // below-threshold matches too.
        const rescued = await structuredMercyFallback(identity);
        if (rescued) {
          log.info("router.bridge_rescued_via_structured", {
            chCardId: rescued.chCardId,
            player: identity.playerName,
            parallel: identity.parallel,
            reason: "ai_matcher_below_threshold",
            originalConfidence: match.confidence,
          });
          return JSON.stringify(rescued);
        }
        log.info("router.bridge_low_confidence", { query, confidence: match.confidence });
        return "";
      }
      // CF-CH-BRIDGE-VARIANT-GUARD (Drew, 2026-07-14): even at high
      // confidence CH's AI matcher may return a card whose variant/number
      // differs from the user's ask when the requested SKU isn't in CH's
      // catalog. Verify variant + number honesty before accepting. On
      // mismatch, fall through to structured mercy fallback (which is
      // variant-aware via pickBestByParallel and returns null on nothing
      // fits — i.e. no CH bridge, no wrong-variant comps).
      // CF-VARIANT-GUARD-SUPERSET (Drew, 2026-07-15): pass the raw query
      // (falling back to the reconstruction) so the guard can accept
      // CH's more-specific parallel/number matches when the user's
      // query text corroborates them. Fixes false rejections on
      // Reptilian / Speckle / X-Fractor and similar parser-under-
      // specification cases.
      const guard = matchHonorsIdentity(match, identity, rawQuery ?? query);
      if (!guard.ok) {
        log.warn("router.bridge_variant_guard_reject", {
          player: identity.playerName,
          parallel: identity.parallel,
          identityNumber: identity.number,
          matchCardId: match.card_id,
          matchVariant: match.variant,
          matchNumber: match.number,
          reason: guard.reason,
          wanted: guard.wanted,
          got: guard.got,
        });
        const rescued = await structuredMercyFallback(identity);
        if (rescued) {
          log.info("router.bridge_rescued_via_structured", {
            chCardId: rescued.chCardId,
            player: identity.playerName,
            parallel: identity.parallel,
            reason: `variant_guard_${guard.reason}`,
          });
          return JSON.stringify(rescued);
        }
        return "";
      }
      return JSON.stringify({ chCardId: match.card_id, confidence: match.confidence });
    },
    BRIDGE_TTL_SEC,
  );

  if (!raw) return null;
  try {
    return JSON.parse(raw) as { chCardId: string; confidence: number };
  } catch {
    return null;
  }
}

/**
 * Fetch trust-guarded CardHedge comps for an identity hint.
 * Returns null when bridge or trust-guard rejects.
 */
/**
 * CF-LOCAL-COMP-FIRST (Drew, 2026-07-17). Reads ch_daily_sales for the
 * identity via localCompStore. Fires in parallel with CH + CS branches.
 *
 * v2 fix (fix/local-comps-schema-match): the first cut called
 * resolveChCardId, which is the SAME slow external CH round-trip that
 * tryCardHedge is already doing — my branch timed out on the same
 * 3s cap. Also, when the bridge failed, we fell through to a structured
 * lookup using `identity.product`/`identity.parallel` which don't equal
 * ch_daily_sales's `card_set`/`variant` fields — 0 rows matched.
 *
 * v2 uses ONLY (playerName + cardYear + number) as the strong SKU
 * triple. All three round-trip cleanly to ch_daily_sales columns
 * (player, year, number) and identify a holding uniquely in
 * practice (e.g. Hartman/2026/CPA-EHA → 226 rows). No external
 * network calls; pure Cosmos-first-partition read is the goal, and
 * even the cross-partition query is bounded by the SKU cardinality.
 */
async function tryLocalComps(
  identity: CardIdentityHint,
  grade: string,
): Promise<{ sales: RoutedSale[]; card: RoutedCard | null; source: "local" } | null> {
  try {
    // v3 (2026-07-17): the /price freetext identity parser sometimes
    // drops `number` when the query uses "#CPA-EHA" — the CH tokenizer
    // treats `#` as a signal boundary ([[suggester-query-no-hash-prefix]]).
    // So we can't require the full triple; require `player` plus at
    // LEAST ONE narrowing field (year OR number). Player alone would
    // be too broad for a hot player like Ohtani (55k rows).

    // CF-LOCAL-COMP-FIRST diagnostic (2026-07-17): the relaxed guard
    // still shows local_count=0 on Ohtani/2024 (which has thousands of
    // rows) — need to see what identity actually reaches this branch.
    // Log every invocation so we can trace what got dropped.
    log.info("router.local_comps_enter", {
      playerName: identity.playerName ?? null,
      cardYear: identity.cardYear ?? null,
      product: identity.product ?? null,
      parallel: identity.parallel ?? null,
      number: identity.number ?? null,
      isAuto: identity.isAuto ?? null,
      grade,
    });

    if (!identity.playerName) {
      log.info("router.local_comps_bail", { reason: "no_player" });
      return null;
    }
    const year = identity.cardYear !== undefined && identity.cardYear !== null
      ? Number(identity.cardYear)
      : undefined;
    if (year === undefined && !identity.number) {
      log.info("router.local_comps_bail", { reason: "no_year_or_number" });
      return null;
    }

    const localResult = await lookupLocalComps(
      {
        player: identity.playerName,
        year,
        number: identity.number,
        // grade filter applied only when caller pinned a graded tier;
        // "Raw" is the default that would over-filter the mixed pool.
        grade: grade && grade !== "Raw" ? grade : undefined,
      },
      { skipPremiums: true },
    );

    log.info("router.local_comps_query_done", {
      totalSales: localResult.totalSales,
      queryMs: localResult.diagnostics.queryMs,
      ruCharge: localResult.diagnostics.ruCharge,
    });

    if (localResult.totalSales === 0) return null;

    // Pull card_id from the first hit — it's what ch_daily_sales
    // stores it under (all matching rows share the same card_id for
    // the same SKU by construction).
    const cardId = localResult.recentSales[0]?.cardId ?? null;
    return {
      sales: localResult.recentSales.map(toRoutedSale),
      card: cardId
        ? {
            card_id: cardId,
            player: identity.playerName,
            set: identity.product,
            year: identity.cardYear,
            number: identity.number,
            variant: identity.parallel,
          }
        : null,
      source: "local",
    };
  } catch (err) {
    log.warn("router.local_comps_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function toRoutedSale(s: LocalCompSale): RoutedSale {
  return {
    price: s.price,
    date: s.saleDate || null,
    grade: s.grader === "Raw" ? "Raw" : `${s.grader} ${s.grade}`.trim(),
    source: "ch_daily_export",
    sale_type: s.saleType || null,
    title: s.description || null,
    url: s.listingUrl || null,
  };
}

async function tryCardHedge(
  identity: CardIdentityHint,
  grade: string,
  rawQuery?: string,
): Promise<{ sales: RoutedSale[]; trustReason: string; chCardId: string } | null> {
  // CF-CH-RAW-QUERY (Drew, 2026-07-15): thread raw user query so
  // resolveChCardId can send it directly to CH's AI matcher instead
  // of our reconstruction. Env-gated inside resolveChCardId.
  const bridge = await resolveChCardId(identity, rawQuery);
  if (!bridge) return null;

  const chIdentity: CardHedgeIdentity = {
    playerSurname: extractSurname(identity.playerName),
    expectedYear:
      identity.cardYear !== undefined && identity.cardYear !== null
        ? String(identity.cardYear)
        : "",
  };
  const trusted = await getTrustedComps(bridge.chCardId, chIdentity, grade);

  if (!trusted.trusted) {
    log.info("router.ch_not_trusted", {
      chCardId: bridge.chCardId,
      reason: trusted.reason,
      pricesByCardLength: trusted.pricesByCardLength,
    });
    return null;
  }

  // CF-VENDOR-EMIT-SOLD-COMPS (Drew, 2026-07-14): every trusted CH sale
  // gets persisted into the unified sold_comps pool. Fire-and-forget;
  // never blocks the caller, never fails the response on emit error.
  // Only fires when trusted (trustReason set) — pool never sees
  // vendor-blob or otherwise-suspect sales.
  //
  // Confidence: 0.8 (higher than CS raw pool because trust-guard has
  // already validated identity via title-cohesion / player-surname).
  // Downstream consumers can still prefer verified=true (1.0) user data.
  void (async () => {
    try {
      const { recordSoldComp } = await import(
        "../portfolioiq/soldCompsStore.service.js"
      );
      const playerName = identity.playerName?.trim();
      if (!playerName) return;
      const cardYear =
        typeof identity.cardYear === "number"
          ? identity.cardYear
          : identity.cardYear != null
            ? parseInt(String(identity.cardYear), 10)
            : null;
      const isAuto =
        identity.isAuto === true ||
        /^CPA|BCPA|BCDA|BDPA|BDA|BPA|BCRA|TCRA|TRA|FCA|USA-|AU-/i.test(
          String(identity.number ?? ""),
        );
      // CF-CH-ROUTER-GRADE-FIX (Drew, 2026-07-19). Thread the queried
      // grade tier through to sold_comps — getTrustedComps was called
      // with `grade` (line 785), but the emit dropped gradeCompany/
      // gradeValue, storing every PSA/BGS sale as raw. Same class as
      // the historicalBackfill grade-drop bug.
      const gradeStr = String(grade ?? "").trim();
      const gradeMatch = gradeStr && gradeStr.toLowerCase() !== "raw"
        ? gradeStr.match(/^([A-Z]+)\s+([0-9.]+)$/i)
        : null;
      const rowGradeCompany = gradeMatch ? gradeMatch[1].toUpperCase() : null;
      const rowGradeValue = gradeMatch && Number.isFinite(Number(gradeMatch[2])) ? Number(gradeMatch[2]) : null;
      for (const c of trusted.comps) {
        if (typeof c.price !== "number" || c.price <= 0) continue;
        if (!c.date) continue;
        // CH sales don't carry a stable per-sale external id.
        // Use (chCardId + date + price-cents + grade) — grade included so
        // a Raw call and a PSA 10 call don't collide on the same doc id.
        const externalId = `${bridge.chCardId}::${c.date}::${Math.round(c.price * 100)}::${gradeStr || "Raw"}`;
        await recordSoldComp({
          cardId: bridge.chCardId,
          playerName,
          cardYear: Number.isFinite(cardYear as any) ? (cardYear as number) : null,
          setName: identity.product ?? null,
          parallel: identity.parallel ?? null,
          cardNumber: identity.number ?? null,
          isAuto,
          gradeCompany: rowGradeCompany,
          gradeValue: rowGradeValue,
          price: c.price,
          soldAt: c.date,
          source: "cardhedge",
          sourceExternalId: externalId,
          contributorUserId: null,
          title: c.title ?? null,
          // CF-COMP-IMAGE-PHASE-0 (Drew, 2026-07-16): CH's /cards/comps
          // returns eBay thumbnails per sale; thread through to sold_comps
          // so comp rows can render the actual image.
          imageUrl: c.image_url ?? null,
          sellerHandle: null,
          verifiedByUser: false,
          confidence: 0.8,
        });
      }
    } catch (err) {
      // CF-VENDOR-EMIT-TELEMETRY (Drew, 2026-07-19). Was silent-swallow.
      // 1% sample so a broken emit path surfaces in App Insights
      // without spamming when the module is globally unhealthy.
      if (Math.random() < 0.01) {
        console.warn(JSON.stringify({
          event: "cardhedge_vendor_emit_failed",
          source: "cardsight.router.tryCardHedge",
          chCardId: bridge.chCardId,
          error: (err as Error)?.message ?? String(err),
          sampled: true,
        }));
      }
    }
  })();

  return {
    chCardId: bridge.chCardId,
    trustReason: trusted.reason,
    sales: trusted.comps.map((c) => ({
      price: c.price,
      date: c.date,
      grade: c.grade,
      source: "cardhedge",
      sale_type: c.sale_type,
      title: c.title,
      url: c.url,
    })),
  };
}

function identityHintFromContext(opts: FindCompsRoutedOptions): CardIdentityHint | null {
  const ctx = opts.queryContext;
  if (!ctx?.playerName) return null;
  return {
    playerName: ctx.playerName,
    cardYear: ctx.cardYear,
    product: ctx.product,
    parallel: ctx.parallel,
    number: ctx.cardNumber,
    isAuto: ctx.isAuto,
  };
}

function narrowTrustReason(
  reason: string,
): "prices_by_card_honest" | "title_cohesion_strong" | undefined {
  return reason === "prices_by_card_honest" || reason === "title_cohesion_strong"
    ? reason
    : undefined;
}

// ── findCompsRouted ─────────────────────────────────────────────────────────

export async function findCompsRouted(
  query: string,
  opts: FindCompsRoutedOptions = {},
): Promise<RoutedResult> {
  const start = Date.now();
  log.info("comp.findComps.start", {
    query,
    playerName: opts.queryContext?.playerName ?? null,
    cardYear: opts.queryContext?.cardYear ?? null,
    parallel: opts.queryContext?.parallel ?? null,
    grade: opts.grade ?? null,
  });

  const identity = identityHintFromContext(opts);
  if (!identity) {
    log.info("comp.findComps.end", { query, outcome: "no_identity", latency_ms: Date.now() - start });
    return emptyResult(["no_identity_for_bridge"]);
  }

  // CF-PARALLEL-VENDOR-MERGE (Drew, 2026-07-15, PR #493): fire CH + all
  // enabled CS branches concurrently and merge the sales pools. Prior
  // architecture was serial with CH-miss cascade — CS branches only ran
  // when CH returned nothing. That meant vendor A's real sold data
  // never joined vendor B's. New architecture broadens coverage by
  // querying both vendors in parallel + deduping the merged pool by
  // marketplace URL (exact-listing join) with a composite-key fallback.
  //
  // Vendor labels stay strictly internal (used for sold_comps ingest,
  // analytics, provenance-tier weighting). Per-comp `source` on the
  // wire's recentComps[] is already stripped upstream (compiqEstimate.
  // service.ts:5442-5452 — see also CF-SOURCE-VENDOR-WIRE-STRIP at
  // responseAssembly.ts:182) so iOS still sees vendor-neutral results.
  //
  // Env-gated cascade retained: each CS branch fires only when its
  // ENABLED flag is on. Turning all 4 off collapses this back to
  // CH-only serial behavior (identical to pre-PR contract).
  const branchTimeoutMs = 3000;
  const grade = opts.grade ?? "Raw";
  const structuredEnabled = process.env.CARDSIGHT_STRUCTURED_BRIDGE_ENABLED === "true";
  const fallbackEnabled = process.env.CARDSIGHT_FALLBACK_ENABLED === "true";
  const backstopEnabled = process.env.CARDSIGHT_PRICING_BACKSTOP_ENABLED === "true";
  // CF-LOCAL-COMP-FIRST (Drew, 2026-07-17). Default OFF — turn on in
  // prod after parity check on Drew's inventory. When enabled, our own
  // ch_daily_sales corpus contributes its comps to the merged pool
  // alongside CH+CS. Doesn't displace any branch; adds volume.
  const localCompEnabled = process.env.LOCAL_COMP_FIRST_ENABLED === "true";

  const withTimeout = <T>(p: Promise<T>, name: string): Promise<T | null> =>
    Promise.race([
      p.catch((err) => {
        log.warn("branch_error", { branch: name, error: err instanceof Error ? err.message : String(err) });
        return null as unknown as T;
      }),
      new Promise<null>((resolve) => setTimeout(() => {
        log.warn("branch_timeout", { branch: name, timeout_ms: branchTimeoutMs });
        resolve(null);
      }, branchTimeoutMs)),
    ]);

  const [chResult, csStructuredResult, csFallbackResult, csBackstopResult, localResult] = await Promise.all([
    // CH always fires (no env flag — CH is the primary contract)
    withTimeout(tryCardHedge(identity, grade, query), "ch"),
    structuredEnabled
      ? withTimeout(tryCardsightStructuredBridge(identity, grade), "cs_structured")
      : Promise.resolve(null),
    fallbackEnabled
      ? withTimeout(tryCardsightFallback(query, identity, grade), "cs_fallback")
      : Promise.resolve(null),
    backstopEnabled
      ? withTimeout(tryCardsightPricingBackstop(query, opts.queryContext, grade), "cs_backstop")
      : Promise.resolve(null),
    localCompEnabled
      ? withTimeout(tryLocalComps(identity, grade), "local")
      : Promise.resolve(null),
  ]);

  // Winning cardId hierarchy: CH-bridged > CS-structured > CS-fallback > CS-backstop.
  // CH-bridged wins because CH's catalog is the more curated of the two. When CH
  // missed but CS resolved a bridge, we adopt the CS card_id — the pool identity
  // must be SOMETHING addressable for sold_comps ingest + persistence.
  const chCard: RoutedCard | null = chResult
    ? {
        card_id: chResult.chCardId,
        player: identity.playerName,
        set: identity.product,
        year: identity.cardYear,
        number: identity.number,
        variant: identity.parallel,
      }
    : null;
  const winningCard: RoutedCard | null =
    chCard
    ?? csStructuredResult?.card
    ?? csFallbackResult?.card
    ?? csBackstopResult?.card
    ?? localResult?.card
    ?? null;

  // Merge sales into one dedupe'd pool. URL is the natural join between
  // CH and CS — both scrape marketplace transaction data, so the same
  // physical eBay listing appears in both pools under the same URL. When
  // URL is absent (older records / CS-native records that lack it), the
  // composite key `soldDate|priceCents|titleHash` catches the same sale
  // by content fingerprint. Local pool is CH-sourced too so URL dedup
  // works uniformly (a per-query CH sale reappearing in the bulk
  // ch_daily_sales corpus collapses to one entry).
  const mergedSales = mergeAndDedupeSales(chResult?.sales ?? [], [
    ...(csStructuredResult?.sales ?? []),
    ...(csFallbackResult?.sales ?? []),
    ...(csBackstopResult?.sales ?? []),
    ...(localResult?.sales ?? []),
  ]);

  // Outcome tag captures which branches actually contributed non-empty results.
  const outcome = [
    chResult && chResult.sales.length > 0 ? "ch" : null,
    csStructuredResult && csStructuredResult.sales.length > 0 ? "cs_structured" : null,
    csFallbackResult && csFallbackResult.sales.length > 0 ? "cs_fallback" : null,
    csBackstopResult && csBackstopResult.sales.length > 0 ? "cs_backstop" : null,
    localResult && localResult.sales.length > 0 ? "local" : null,
  ].filter((s) => s !== null).join("+") || "none";

  log.info("comp.findComps.end", {
    query,
    cardId: winningCard?.card_id ?? null,
    result_count: mergedSales.length,
    ch_count: chResult?.sales.length ?? 0,
    cs_structured_count: csStructuredResult?.sales.length ?? 0,
    cs_fallback_count: csFallbackResult?.sales.length ?? 0,
    cs_backstop_count: csBackstopResult?.sales.length ?? 0,
    local_count: localResult?.sales.length ?? 0,
    duplicates_collapsed:
      (chResult?.sales.length ?? 0)
      + (csStructuredResult?.sales.length ?? 0)
      + (csFallbackResult?.sales.length ?? 0)
      + (csBackstopResult?.sales.length ?? 0)
      + (localResult?.sales.length ?? 0)
      - mergedSales.length,
    latency_ms: Date.now() - start,
    outcome,
  });

  if (!winningCard && mergedSales.length === 0) {
    return emptyResult(["all_branches_empty"]);
  }

  return {
    card: winningCard,
    sales: mergedSales,
    variantWarning: [],
    aiCategory: null,
    chCardId: chResult?.chCardId,
    chTrustReason: chResult ? narrowTrustReason(chResult.trustReason) : undefined,
  };
}

/**
 * CF-PARALLEL-VENDOR-MERGE (PR #493): merge CH sales with CS-branch
 * sales into one dedupe'd pool. CH sales are added first so their
 * identity + metadata wins on collision (CH catalog is more curated
 * than CS's title-matched marketplace scrape). Vendor labels on each
 * RoutedSale stay preserved for downstream analytics / sold_comps
 * ingest / provenance weighting; the wire layer strips them.
 *
 * Dedup priority:
 *   1. URL exact match (natural join for marketplace listings)
 *   2. Composite fingerprint: soldDate | priceCents | titleHash(50 chars)
 *
 * When a dup is detected, the first-seen row wins (CH gets priority
 * because it's added first); subsequent duplicates are dropped. This
 * preserves CH's provenance tier + trust flags on the survivor.
 */
function mergeAndDedupeSales(
  chSales: RoutedSale[],
  csSales: RoutedSale[],
): RoutedSale[] {
  const dedupKey = (s: RoutedSale): string => {
    const url = (s as unknown as { url?: string; image_url?: string }).url
      ?? (s as unknown as { url?: string; image_url?: string }).image_url;
    if (typeof url === "string" && url.length > 0) return `url:${url}`;
    const date = s.date ?? "";
    const priceCents = Math.round((s.price ?? 0) * 100);
    const titleHash = (s.title ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 50);
    return `comp:${date}|${priceCents}|${titleHash}`;
  };

  const seen = new Set<string>();
  const merged: RoutedSale[] = [];

  // CH first — highest provenance tier wins on collision
  for (const s of chSales) {
    const k = dedupKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(s);
  }
  for (const s of csSales) {
    const k = dedupKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(s);
  }
  return merged;
}

// ── searchCardsRouted ───────────────────────────────────────────────────────

export async function searchCardsRouted(
  query: string,
  limit: number = 20,
  filters?: CardSearchFilters,
): Promise<RoutedCard[]> {
  // CF-CH-STRUCTURED-SEARCH-FILTERS (2026-06-28): forward optional player/
  // set/rookie filters through to CardHedge. Omitting them preserves the
  // pre-CF call shape exactly — every existing caller without filters is
  // unaffected.
  //
  // CF-CS-CATALOG-AUGMENT (Drew, 2026-07-21): CH lags CS on new product
  // lines (e.g. 2026 Bowman Sapphire). Fire CH and CS in parallel; merge
  // CS-only cards onto the tail of the CH result set so users searching
  // for recent products get catalog hits. Env-gated on the existing
  // CARDSIGHT_STRUCTURED_BRIDGE_ENABLED flag (true in prod).
  const csEnabled = process.env.CARDSIGHT_STRUCTURED_BRIDGE_ENABLED === "true";
  const [chHits, csHitsRaw] = await Promise.all([
    chSearchCards(query, limit, filters),
    csEnabled ? csSearchCatalog(query, { take: Math.min(10, limit) }).catch(() => []) : Promise.resolve([]),
  ]);

  const routedFromCh = chHits.map(chCardToRoutedCard);
  const seen = new Set(routedFromCh.map(canonicalCardKey));
  const csAugment: RoutedCard[] = [];
  for (const hit of csHitsRaw) {
    const mapped = csCatalogHitToRoutedCard(hit);
    const key = canonicalCardKey(mapped);
    if (seen.has(key)) continue;
    seen.add(key);
    csAugment.push(mapped);
  }

  const routed = [...routedFromCh, ...csAugment];
  // CF-PRICE-BY-ID-PLAYER-RESOLVE (2026-06-27): stash each card's metadata by
  // card_id so the pinned /price-by-id path can later recover player/set/etc.
  // Fire-and-forget — a cache write failure must never break search.
  void cacheCardMeta(routed);
  return routed;
}

/**
 * Persist RoutedCard metadata under `card-meta:{card_id}` so the pinned
 * /price-by-id path can recover identity from a bare card_id. Best-effort:
 * only cards carrying a real player are stored (a numeric-only or empty
 * player is not worth caching), and any write error is swallowed.
 */
async function cacheCardMeta(cards: RoutedCard[]): Promise<void> {
  await Promise.all(
    cards
      .filter((c) => typeof c.card_id === "string" && c.card_id.length > 0 && !!c.player)
      .map((c) =>
        cacheSet(cardMetaKey(c.card_id), JSON.stringify(c), CARD_META_TTL_SEC).catch(() => {}),
      ),
  );
}

/**
 * Recover a previously-searched card's metadata by its card_id. Returns null
 * on cache miss or parse failure. Used by the pinned /price-by-id path to
 * surface the real player when iOS sends query=nil.
 */
export async function getCardMetaById(cardId: string): Promise<RoutedCard | null> {
  if (!cardId) return null;
  try {
    const raw = await cacheGet(cardMetaKey(cardId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RoutedCard;
    return parsed && typeof parsed.card_id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

// ── getCardSalesRouted ──────────────────────────────────────────────────────

/**
 * Fetch CardHedge comps for an identity. The legacy `cardId` parameter
 * (formerly a Cardsight card_id) is now used only as a telemetry tag —
 * the actual CH card_id is resolved from `identity` via the bridge.
 *
 * Callers without an identity get an empty array.
 */
export async function getCardSalesRouted(
  cardId: string,
  grade: string,
  limit: number,
  identity?: CardIdentityHint,
): Promise<RoutedSale[]> {
  const result = await getCardSalesRoutedWithProvenance(cardId, grade, limit, identity);
  return result.sales;
}

export async function getCardSalesRoutedWithProvenance(
  cardId: string,
  grade: string,
  limit: number,
  identity?: CardIdentityHint,
): Promise<{
  sales: RoutedSale[];
  chCardId?: string;
  chTrustReason?: "prices_by_card_honest" | "title_cohesion_strong";
}> {
  void limit;
  void cardId;

  if (!identity || !identity.playerName) {
    return { sales: [] };
  }

  const ch = await tryCardHedge(identity, grade);
  if (!ch) {
    return { sales: [] };
  }

  log.info("router.ch_served", {
    chCardId: ch.chCardId,
    count: ch.sales.length,
    trustReason: ch.trustReason,
  });
  return {
    sales: ch.sales,
    chCardId: ch.chCardId,
    chTrustReason: narrowTrustReason(ch.trustReason),
  };
}

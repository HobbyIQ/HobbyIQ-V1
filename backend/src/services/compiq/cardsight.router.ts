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
// CF-CS-PRICING-BACKSTOP (Drew, 2026-07-15): ultimate backstop when
// neither CH bridge nor CS catalog resolves the SKU. See
// cardsightPricingBackstop.ts for the rationale.
import { tryCardsightPricingBackstop } from "./cardsightPricingBackstop.js";

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
  match: { card_id?: string | null; variant?: string | null; number?: string | null } | null,
  identity: { parallel?: string | null; number?: string | null },
): { ok: true } | { ok: false; reason: "card_number_mismatch" | "parallel_mismatch"; wanted: string; got: string } {
  if (!match) return { ok: true };  // no match to guard against
  // Card number guard first — cheap and definitive.
  if (identity.number && match.number) {
    const wantNum = String(identity.number).toLowerCase().trim();
    const gotNum = String(match.number).toLowerCase().trim();
    if (wantNum && gotNum && wantNum !== gotNum) {
      return { ok: false, reason: "card_number_mismatch", wanted: wantNum, got: gotNum };
    }
  }
  // Parallel guard — normalize both sides and require EXACT equality. Any
  // widening ("Refractor" request → "Blue Refractor" catalog) or narrowing
  // ("Blue Refractor" request → "Refractor" catalog) is a different SKU
  // with its own sub-market price band. Only a byte-identical normalized
  // parallel is safe to bridge.
  if (identity.parallel && match.variant) {
    const want = normalizeParallelForVariantGuard(identity.parallel);
    const got = normalizeParallelForVariantGuard(match.variant);
    if (want && got && want !== got) {
      return { ok: false, reason: "parallel_mismatch", wanted: want, got };
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
 */
async function resolveChCardId(
  identity: CardIdentityHint,
): Promise<{ chCardId: string; confidence: number } | null> {
  const query = buildCardHedgeQuery(identity);
  if (!query) return null;

  const raw = await cacheWrap(
    identityCacheKey(query),
    async () => {
      const match = await chIdentifyCard(query);
      if (!match || !match.card_id) {
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
      const guard = matchHonorsIdentity(match, identity);
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
async function tryCardHedge(
  identity: CardIdentityHint,
  grade: string,
): Promise<{ sales: RoutedSale[]; trustReason: string; chCardId: string } | null> {
  const bridge = await resolveChCardId(identity);
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
      for (const c of trusted.comps) {
        if (typeof c.price !== "number" || c.price <= 0) continue;
        if (!c.date) continue;
        // CH sales don't carry a stable per-sale external id.
        // Use (chCardId + date + price-cents) as the composite key —
        // idempotent for the same physical sale re-observed on rewrites.
        const externalId = `${bridge.chCardId}::${c.date}::${Math.round(c.price * 100)}`;
        await recordSoldComp({
          cardId: bridge.chCardId,
          playerName,
          cardYear: Number.isFinite(cardYear as any) ? (cardYear as number) : null,
          setName: identity.product ?? null,
          parallel: identity.parallel ?? null,
          cardNumber: identity.number ?? null,
          isAuto,
          price: c.price,
          soldAt: c.date,
          source: "cardhedge",
          sourceExternalId: externalId,
          contributorUserId: null,
          title: c.title ?? null,
          imageUrl: null,
          sellerHandle: null,
          verifiedByUser: false,
          confidence: 0.8,
        });
      }
    } catch { /* swallow — vendor emit is auxiliary */ }
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

  try {
    const ch = await tryCardHedge(identity, opts.grade ?? "Raw");
    if (!ch) {
      // CF-CARDSIGHT-FALLBACK-REVIVAL (Drew, 2026-07-14): CH-miss fallback.
      // Env-gated (CARDSIGHT_FALLBACK_ENABLED=true, default off) so we can
      // stage rollout separately from ingest + read. Only fires when CH has
      // literally no bridge — CH-thin / CH-untrusted cases keep the empty
      // return so the trust-guard behavior is preserved. See
      // cardsightFallback.ts header for the full rationale.
      if (process.env.CARDSIGHT_FALLBACK_ENABLED === "true") {
        const cs = await tryCardsightFallback(query, identity, opts.grade ?? "Raw");
        if (cs) {
          log.info("comp.findComps.end", {
            query,
            cardId: cs.card?.card_id ?? null,
            result_count: cs.sales.length,
            latency_ms: Date.now() - start,
            outcome: "cardsight_fallback",
            vendor: "cardsight",
          });
          return cs;
        }
      }
      // CF-CS-PRICING-BACKSTOP (Drew, 2026-07-15): tier-3 fallback when
      // neither vendor's canonical catalog has the SKU. Searches raw
      // marketplace listing titles — surfaces real transaction evidence
      // for cards like Blue Refractor Autos, /150 parallels, etc. that
      // are catalog-gaps in both CH and CS. No cardId, but real prices.
      // Env-gated (CARDSIGHT_PRICING_BACKSTOP_ENABLED=true, default off).
      if (process.env.CARDSIGHT_PRICING_BACKSTOP_ENABLED === "true") {
        const backstop = await tryCardsightPricingBackstop(
          query,
          opts.queryContext,
          opts.grade ?? "Raw",
        );
        if (backstop) {
          log.info("comp.findComps.end", {
            query,
            cardId: "",  // no canonical bridge — backstop is bridge-less
            result_count: backstop.sales.length,
            latency_ms: Date.now() - start,
            outcome: "cardsight_pricing_backstop",
            vendor: "cardsight",
          });
          return backstop;
        }
      }
      log.info("comp.findComps.end", { query, outcome: "ch_unavailable", latency_ms: Date.now() - start });
      return emptyResult(["ch_no_match_or_untrusted"]);
    }

    log.info("router.ch_served", {
      query,
      chCardId: ch.chCardId,
      count: ch.sales.length,
      trustReason: ch.trustReason,
      via: "findCompsRouted",
    });
    log.info("comp.findComps.end", {
      query,
      cardId: ch.chCardId,
      result_count: ch.sales.length,
      latency_ms: Date.now() - start,
      outcome: "ok",
    });

    const card: RoutedCard = {
      card_id: ch.chCardId,
      player: identity.playerName,
      set: identity.product,
      year: identity.cardYear,
      number: identity.number,
      variant: identity.parallel,
    };
    return {
      card,
      sales: ch.sales,
      variantWarning: [],
      aiCategory: null,
      chCardId: ch.chCardId,
      chTrustReason: narrowTrustReason(ch.trustReason),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("ch_error", { query, error: msg });
    log.info("comp.findComps.end", { query, outcome: "error", latency_ms: Date.now() - start });
    return emptyResult(["ch_error"]);
  }
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
  const hits = await chSearchCards(query, limit, filters);
  const routed = hits.map(chCardToRoutedCard);
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

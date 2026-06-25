/**
 * Cardsight routing layer.
 *
 * Post-CF-CARDHEDGE-HARD-CUTOVER (2026-05-30) the file was collapsed to
 * Cardsight-only. Re-introduced in CF-CH-P3-SEAM (2026-06-25) as a true
 * vendor seam: CardHedge is tried first via the trust-guard
 * (cardhedge.client.ts:getTrustedComps), Cardsight is the floor. Callers
 * still see vendor-neutral RoutedCard / RoutedSale / RoutedResult and do
 * not branch on vendor.
 *
 * Bridge:
 *   CS-cardId + identity hint  -> CH-cardId via /v1/cards/card-match.
 *   Confidence < 0.80           -> CH miss, fall to Cardsight.
 *   Confidence >= 0.80          -> trust-guard against the CH cardId.
 *     - prices_by_card_honest / title_cohesion_strong -> use CH
 *     - blob_signature / no_real_data                  -> fall to Cardsight
 *   Bridge result cached 24h on (csCardId, identity-query).
 *
 * Log event vocabulary:
 *   - "cardsight.findComps.start" / "cardsight.findComps.end"
 *   - "identity_source"
 *   - "getCardDetail_failed" (warn)
 *   - "cardsight_error" (warn)
 *   - "router.bridge_no_match" / "router.bridge_low_confidence"
 *   - "router.ch_served" (CH path won)
 *   - "router.ch_not_trusted" (CH bridged but trust-guard rejected)
 */

import { searchCatalog, getCardDetail, getPricing, CardsightTimeoutError } from "./cardsight.client.js";
import { resolveCardId } from "./cardsight.mapper.js";
import { translateResponse } from "./cardsight.translator.js";
import {
  applyParallelTitleMatch,
  collapsePriceSource,
  type ParallelPriceSource,
  type UserFacingPriceSource,
} from "./parallelTitleMatch.js";
import {
  identifyCard as chIdentifyCard,
  getTrustedComps,
  type CardHedgeIdentity,
} from "./cardhedge.client.js";
import { cacheWrap } from "../shared/cache.service.js";

// ── CardHedge bridge constants ──────────────────────────────────────────────
const BRIDGE_TTL_SEC = 24 * 3600;          // 24h — CS-id -> CH-id mapping is stable
const MIN_BRIDGE_CONFIDENCE = 0.80;        // CH card-match confidence floor

/**
 * Identity hint required to bridge a Cardsight card_id over to CardHedge
 * via /v1/cards/card-match. Optional fields tighten the match but are not
 * required; `playerName` is the only hard-required field (CH match is
 * fuzzy-text-driven and an empty playerName cannot resolve usefully).
 */
export interface CardIdentityHint {
  playerName: string;
  cardYear?: string | number;
  product?: string;
  parallel?: string;
  number?: string;
  isAuto?: boolean;
}

const log = {
  info: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "cardsight.router", ...fields })),
  warn: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "cardsight.router", level: "warn", ...fields })),
  debug: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "cardsight.router", level: "debug", ...fields })),
};

// Routed-result types. Relocated here from cardhedge.client.ts (deleted
// per CF-CARDHEDGE-HARD-CUTOVER) and renamed to vendor-neutral
// RoutedCard / RoutedSale per CF-CARDHEDGE-NAMING-CLEANUP.

export interface RoutedCard {
  card_id: string;
  player?: string;
  set?: string;
  year?: number | string;
  number?: string;
  variant?: string;
  title?: string;
  name?: string;
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

type RoutedResult = {
  card: RoutedCard | null;
  sales: RoutedSale[];
  variantWarning: string[];
  aiCategory: string | null;
  // CF-CARDSIGHT-RESOLVER-REDESIGN: parallel-match attribution. Internal
  // fine-grained source for telemetry; user-facing 3-category collapse
  // for response shape. Both surfaced -- response-shaping layer in
  // compiqEstimate.service.ts decides which (typically just user-facing).
  priceSourceInternal?: ParallelPriceSource;
  priceSource?: UserFacingPriceSource;
  /** Number of sale records after title-match filter (when applied). */
  parallelMatchFilteredCount?: number;
  /** Total records in unified bucket before filter (for "N of M" disclosure). */
  parallelMatchUnifiedCount?: number;
};

export type QueryContext = {
  playerName?: string;
  cardYear?: string | number;
  product?: string;
  parallel?: string;
  // Phase 2 v2 -- defect #11: cardNumber threaded through so resolveCardId can
  // disambiguate via detail-probe AND so the LRU cache key includes it for
  // proper per-cardNumber cache entries.
  cardNumber?: string;
  gradeCompany?: string;
  gradeValue?: string;
  // CF-CARDSIGHT-AUTO-COLOR-RESOLVE-+-PARALLEL-NORMALIZE (2026-06-01):
  // effectiveIsAuto from compiqEstimate, threaded so resolveCardId can
  // re-select candidates whose card-number auto-prefix matches user intent.
  isAuto?: boolean;
  // CF-REPRICE-PINNED-AUTHORITATIVE (2026-06-17): when set true alongside
  // a pinned cardsightCardId, fetchComps forces the pinned-id branch
  // regardless of whether the composed cardTitle differs from the pinned
  // id. Default-off; only set by autoPriceHolding (portfolio reprice path)
  // where the stored cardsightCardId is authoritative and the composed
  // cardTitle is a derived display label, not a free-text override.
  // queryContext is the existing plumbing channel from computeEstimate
  // down to fetchComps — adding here keeps the surface additive (other
  // callers ignore the flag) and avoids a 6th positional param on the
  // already-five-parameter fetchComps signature.
  pinnedAuthoritative?: boolean;
};

export type FindCompsRoutedOptions = {
  grade?: string;
  limit?: number;
  gradeCompany?: string;
  gradeValue?: string;
  queryContext?: QueryContext;
};

function toCardsightQuery(query: string, opts: FindCompsRoutedOptions) {
  const ctx = opts.queryContext ?? {};
  return {
    playerName: ctx.playerName ?? query,
    cardYear: ctx.cardYear,
    product: ctx.product,
    parallel: ctx.parallel,
    cardNumber: ctx.cardNumber,
    gradeCompany: opts.gradeCompany ?? ctx.gradeCompany,
    gradeValue: opts.gradeValue ?? ctx.gradeValue,
    // CF-CARDSIGHT-AUTO-COLOR-RESOLVE-+-PARALLEL-NORMALIZE (2026-06-01)
    isAuto: ctx.isAuto,
  };
}

function emptyCardsightResult(warnings: string[] = []): RoutedResult {
  return {
    card: null,
    sales: [],
    variantWarning: warnings,
    aiCategory: null,
  };
}

function csToRoutedCard(cs: any): RoutedCard {
  return {
    card_id: cs.id,
    player: cs.player ?? undefined,
    set: cs.setName ?? undefined,
    year: cs.year ?? undefined,
    number: cs.number ?? undefined,
    title: cs.name ?? undefined,
    name: cs.name ?? undefined,
  };
}

// ── CardHedge bridge ────────────────────────────────────────────────────────

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

/**
 * Extract surname for the trust-guard's title-cohesion check. Strips trailing
 * generational suffixes (Jr, Sr, II/III/IV with optional period) so the
 * surname is "Acuna" for "Ronald Acuna Jr", not "Jr".
 */
function extractSurname(playerName: string): string {
  if (!playerName) return "";
  const tokens = playerName.toLowerCase().trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  let idx = tokens.length - 1;
  while (idx > 0 && GENERATIONAL_SUFFIX_RE.test(tokens[idx])) idx--;
  return tokens[idx];
}

function bridgeCacheKey(csCardId: string, query: string): string {
  return ["router:cs-to-ch", csCardId, query.toLowerCase().replace(/\s+/g, " ").trim()].join(":");
}

/**
 * Bridge a Cardsight card_id over to CardHedge via /v1/cards/card-match.
 * Cached 24h on (csCardId, identity query) — card_id mappings are stable.
 *
 * Returns:
 *   { chCardId, confidence }   — match resolved at >= MIN_BRIDGE_CONFIDENCE
 *   null                        — no match, low confidence, or empty query
 */
async function bridgeCsToCh(
  csCardId: string,
  identity: CardIdentityHint,
): Promise<{ chCardId: string; confidence: number } | null> {
  const query = buildCardHedgeQuery(identity);
  if (!query) return null;

  const raw = await cacheWrap(
    bridgeCacheKey(csCardId, query),
    async () => {
      const match = await chIdentifyCard(query);
      if (!match || !match.card_id) {
        log.info("router.bridge_no_match", { csCardId, query });
        return "";
      }
      if (match.confidence < MIN_BRIDGE_CONFIDENCE) {
        log.info("router.bridge_low_confidence", { csCardId, query, confidence: match.confidence });
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
 * Internal: try CardHedge for a Cardsight card_id + identity. Returns the
 * trust-guarded comps when CH wins; null when CH should be skipped (no
 * bridge, blob, or no real data). Caller falls through to Cardsight on null.
 */
async function tryCardHedgeForCs(
  csCardId: string,
  identity: CardIdentityHint,
  grade: string,
): Promise<{ sales: RoutedSale[]; trustReason: string; chCardId: string } | null> {
  const bridge = await bridgeCsToCh(csCardId, identity);
  if (!bridge) return null;

  const surname = extractSurname(identity.playerName);
  const expectedYear = identity.cardYear !== undefined && identity.cardYear !== null
    ? String(identity.cardYear)
    : "";

  const chIdentity: CardHedgeIdentity = { playerSurname: surname, expectedYear };
  const trusted = await getTrustedComps(bridge.chCardId, chIdentity, grade);

  if (!trusted.trusted) {
    log.info("router.ch_not_trusted", {
      csCardId,
      chCardId: bridge.chCardId,
      reason: trusted.reason,
      pricesByCardLength: trusted.pricesByCardLength,
    });
    return null;
  }

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

// ── findCompsRouted ─────────────────────────────────────────────────────────

async function findCompsViaCardsight(
  query: string,
  opts: FindCompsRoutedOptions,
): Promise<RoutedResult> {
  const start = Date.now();
  log.info("cardsight.findComps.start", {
    query,
    playerName: opts.queryContext?.playerName ?? null,
    cardYear: opts.queryContext?.cardYear ?? null,
    parallel: opts.queryContext?.parallel ?? null,
    gradeCompany: opts.gradeCompany ?? opts.queryContext?.gradeCompany ?? null,
    gradeValue: opts.gradeValue ?? opts.queryContext?.gradeValue ?? null,
    ts: start,
  });
  let outcome: "ok" | "empty" | "no_match" | "no_pricing" | "error" | "timeout" = "ok";
  let cardId: string | null = null;
  let result_count = 0;
  try {
    const mapped = await resolveCardId(toCardsightQuery(query, opts));
    if (!mapped.cardId) {
      outcome = "no_match";
      return emptyCardsightResult(["cardsight_no_catalog_match", ...mapped.warnings]);
    }
    cardId = mapped.cardId;

    // CF-CARDSIGHT-CARDIDENTITY-COMPLETENESS (investigation a6c6dd9):
    // /pricing/{id}'s embedded `card` object is SPARSE -- setName/year
    // come back undefined for Cardsight-exclusive resolved cards.
    // /catalog/cards/{id} (getCardDetail) returns RICH metadata
    // (releaseName, setName, releaseYear, parallels[]). Fetch both in
    // parallel; build cardIdentity preferring detail's fields with
    // graceful degradation to pricing.card if detail fails.
    const [pricing, detail] = await Promise.all([
      getPricing(mapped.cardId, { parallelId: mapped.parallelId ?? undefined }),
      getCardDetail(mapped.cardId).catch((err) => {
        log.warn("getCardDetail_failed", {
          cardId: mapped.cardId,
          error: (err as Error)?.message ?? String(err),
        });
        return null;
      }),
    ]);

    const detailOk = detail !== null && !detail.notFound;

    // CF-CARDSIGHT-RESOLVER-REDESIGN: title-match-with-specificity-guard.
    const siblingParallels = detailOk && detail!.parallels ? detail!.parallels : [];
    const titleMatchOutcome = applyParallelTitleMatch({
      pricingResponse: pricing,
      pricingCameFromUnifiedFallback: pricing.__parallelIdFilterFellBack === true,
      userParallelInput: opts.queryContext?.parallel,
      matchedParallelId: mapped.parallelId,
      siblingParallels,
    });
    const filteredPricing = titleMatchOutcome.response;

    // CF-CARDSIGHT-TRANSLATER-GRADE-WIRING: bridge queryContext grade
    // fields into the translator.
    const translated = translateResponse(filteredPricing, {
      gradeCompany: opts.gradeCompany ?? opts.queryContext?.gradeCompany,
      gradeValue: opts.gradeValue ?? opts.queryContext?.gradeValue,
    });

    log.info("identity_source", {
      cardId: mapped.cardId,
      source: detailOk ? "getCardDetail" : (detail === null ? "degraded" : "not_found"),
      // CF-CARDSIGHT-PRICING-CARD-SCHEMA (2026-06-07): pricing fallback now
      // reads from the actual wire shape — set.release is the product line
      // (matches CardsightCardDetail.releaseName semantically). The legacy
      // `pricing.card?.setName` read returned undefined on every call.
      set: detailOk
        ? detail!.releaseName
        : (pricing.card?.set?.release ?? null),
      year: detailOk ? detail!.year : (pricing.card?.set?.year ?? null),
    });

    const baseCard: RoutedCard = {
      card_id: mapped.cardId,
      title: pricing.card?.name ?? undefined,
      // CF-CARDSIGHT-PRICING-CARD-SCHEMA (2026-06-07): pricing.card has no
      // `player` field — the player name lives in `.name`. The legacy
      // `?? pricing.card?.player` read was always undefined. Map directly
      // from `.name` now.
      player: pricing.card?.name ?? undefined,
      // cardIdentity.set carries the PRODUCT LINE. detail.releaseName is
      // the product line; pricing.card.set.release is its pricing-wire
      // analog. (set.name is the SUBSET — "Base Set" — which is NOT what
      // this field carries.)
      set: detailOk
        ? detail!.releaseName
        : (pricing.card?.set?.release ?? undefined),
      year: detailOk
        ? detail!.year
        : (pricing.card?.set?.year ?? undefined),
      number: pricing.card?.number ?? undefined,
      variant: mapped.parallelId ?? undefined,
    };

    if (translated.length === 0) {
      outcome = "no_pricing";
      return {
        card: baseCard,
        sales: [],
        variantWarning: ["cardsight_no_pricing_data", ...mapped.warnings],
        aiCategory: null,
        priceSourceInternal: titleMatchOutcome.priceSource,
        priceSource: collapsePriceSource(titleMatchOutcome.priceSource),
        parallelMatchFilteredCount: titleMatchOutcome.filteredCount,
        parallelMatchUnifiedCount: titleMatchOutcome.totalUnifiedCount,
      };
    }

    result_count = translated.length;
    if (result_count === 0) outcome = "empty";

    return {
      card: baseCard,
      sales: translated.map((s) => ({
        title: s.title,
        price: s.price,
        date: s.soldDate,
        grade: opts.grade ?? "Raw",
        source: "cardsight",
        sale_type: null,
        url: null,
      })),
      variantWarning: mapped.warnings,
      aiCategory: null,
      priceSourceInternal: titleMatchOutcome.priceSource,
      priceSource: collapsePriceSource(titleMatchOutcome.priceSource),
      parallelMatchFilteredCount: titleMatchOutcome.filteredCount,
      parallelMatchUnifiedCount: titleMatchOutcome.totalUnifiedCount,
    };
  } catch (err) {
    outcome = err instanceof CardsightTimeoutError ? "timeout" : "error";
    throw err;
  } finally {
    log.info("cardsight.findComps.end", {
      query,
      cardId,
      result_count,
      latency_ms: Date.now() - start,
      outcome,
    });
  }
}

export async function findCompsRouted(
  query: string,
  opts: FindCompsRoutedOptions = {},
): Promise<RoutedResult> {
  // P3 seam: Cardsight resolves identity + serves as the floor. If
  // queryContext carries enough identity to bridge over to CardHedge,
  // and CH passes the trust-guard, swap the sales[] array for CH-sourced
  // comps. Card identity + warnings stay on the CS-resolved metadata.
  try {
    const csResult = await findCompsViaCardsight(query, opts);

    const identity = identityHintFromContext(opts);
    if (identity && csResult.card?.card_id) {
      const ch = await tryCardHedgeForCs(
        csResult.card.card_id,
        identity,
        opts.grade ?? "Raw",
      );
      if (ch) {
        log.info("router.ch_served", {
          query,
          csCardId: csResult.card.card_id,
          chCardId: ch.chCardId,
          count: ch.sales.length,
          trustReason: ch.trustReason,
          via: "findCompsRouted",
        });
        return {
          ...csResult,
          sales: ch.sales,
        };
      }
    }
    return csResult;
  } catch (err: any) {
    if (err instanceof CardsightTimeoutError) throw err;
    log.warn("cardsight_error", { query, error: err?.message ?? String(err) });
    return emptyCardsightResult(["cardsight_error"]);
  }
}

// ── searchCardsRouted ───────────────────────────────────────────────────────

export async function searchCardsRouted(
  query: string,
  limit: number = 20,
): Promise<RoutedCard[]> {
  // Post-CF-CARDHEDGE-HARD-CUTOVER: Cardsight-only.
  const cs = await searchCatalog(query, { take: limit });
  return cs.map(csToRoutedCard);
}

// ── getCardSalesRouted ──────────────────────────────────────────────────────

/**
 * Fetch comps for a Cardsight card_id. When `identity` is provided, attempts
 * CardHedge via the bridge first; on any non-trusted result, falls through to
 * Cardsight (existing behavior). Without `identity`, behavior is identical to
 * pre-P3 — pure Cardsight, no CH call. This keeps existing callers' behavior
 * byte-for-byte unchanged until P5 threads identity through.
 *
 * Each returned RoutedSale carries `source` ("cardhedge" | "cardsight").
 */
export async function getCardSalesRouted(
  cardId: string,
  grade: string,
  limit: number,
  identity?: CardIdentityHint,
): Promise<RoutedSale[]> {
  void limit; // Cardsight returns the full record set; caller slices.

  // P3: try CardHedge first when identity is provided.
  if (identity && identity.playerName) {
    const ch = await tryCardHedgeForCs(cardId, identity, grade);
    if (ch) {
      log.info("router.ch_served", {
        csCardId: cardId,
        chCardId: ch.chCardId,
        count: ch.sales.length,
        trustReason: ch.trustReason,
      });
      return ch.sales;
    }
  }

  // Cardsight floor (unchanged behavior).
  const pricing = await getPricing(cardId);
  const translated = translateResponse(pricing, {});
  return translated.map((t) => ({
    price: t.price,
    date: t.soldDate ?? null,
    grade,
    source: "cardsight",
    sale_type: null,
    title: t.title ?? null,
    url: null,
  }));
}

/** Build a CardIdentityHint from the FindCompsRouted queryContext. */
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

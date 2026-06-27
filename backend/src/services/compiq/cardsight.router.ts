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
} from "./cardhedge.client.js";
import type { ParallelPriceSource, UserFacingPriceSource } from "./parallelTitleMatch.js";
import { cacheWrap } from "../shared/cache.service.js";

// ── Bridge constants ────────────────────────────────────────────────────────
const BRIDGE_TTL_SEC = 24 * 3600;
const MIN_BRIDGE_CONFIDENCE = 0.80;

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

function chCardToRoutedCard(c: CardHedgeCard): RoutedCard {
  return {
    card_id: c.card_id,
    player: c.player ?? undefined,
    set: c.set ?? undefined,
    year: c.year ?? undefined,
    number: c.number ?? undefined,
    variant: c.variant ?? undefined,
    title: c.title ?? c.name ?? undefined,
    name: c.name ?? undefined,
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
  return ["router:ch-identify", query.toLowerCase().replace(/\s+/g, " ").trim()].join(":");
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
        log.info("router.bridge_no_match", { query });
        return "";
      }
      if (match.confidence < MIN_BRIDGE_CONFIDENCE) {
        log.info("router.bridge_low_confidence", { query, confidence: match.confidence });
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
): Promise<RoutedCard[]> {
  const hits = await chSearchCards(query, limit);
  return hits.map(chCardToRoutedCard);
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

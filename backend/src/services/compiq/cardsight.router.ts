/**
 * Cardsight routing layer. Post-CF-CARDHEDGE-HARD-CUTOVER (2026-05-30):
 * collapsed to Cardsight-only -- the mode toggle (off/shadow/primary/
 * exclusive) is removed because CardHedge subscription was cancelled
 * and shared/cardhedge.client.ts is deleted.
 *
 * Engine code does not see the routing -- only routed result. See
 * ADR-cardsight-migration-2026-05-18.md for the original migration design.
 *
 * Routed-result types RoutedCard / RoutedSale are vendor-neutral and
 * describe the stable contract for the pricing pipeline downstream
 * (relocated here from the deleted cardhedge.client.ts and renamed per
 * CF-CARDHEDGE-NAMING-CLEANUP).
 *
 * Log event vocabulary (post-cutover, simplified):
 *   - "cardsight.findComps.start" / "cardsight.findComps.end"
 *   - "identity_source"
 *   - "getCardDetail_failed" (warn)
 *   - "cardsight_error" (warn)
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
      set: detailOk
        ? detail!.releaseName
        : (pricing.card?.setName ?? null),
      year: detailOk ? detail!.year : (pricing.card?.year ?? null),
    });

    const baseCard: RoutedCard = {
      card_id: mapped.cardId,
      title: pricing.card?.name ?? undefined,
      // Defect #7 fix: Cardsight's pricing.card has no `player` field
      // (player name lives in `name`). Fallback chain preserved through
      // CF-CARDHEDGE-HARD-CUTOVER.
      player: pricing.card?.player ?? pricing.card?.name ?? undefined,
      // cardIdentity.set carries the PRODUCT LINE; Cardsight's `releaseName`
      // is the product line; `setName` is the subset within a release.
      set: detailOk
        ? detail!.releaseName
        : (pricing.card?.setName ?? undefined),
      year: detailOk
        ? detail!.year
        : (pricing.card?.year ?? undefined),
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
  // Post-CF-CARDHEDGE-HARD-CUTOVER: mode discriminant collapsed. Always
  // routes via Cardsight. Errors (other than timeouts, which propagate)
  // surface as empty result with "cardsight_error" warning.
  try {
    return await findCompsViaCardsight(query, opts);
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

export async function getCardSalesRouted(
  cardId: string,
  grade: string,
  limit: number,
): Promise<RoutedSale[]> {
  // Post-CF-CARDHEDGE-HARD-CUTOVER: `cardIdSource` discriminant removed.
  // Every cardId is now a Cardsight UUID. `limit` retained in the
  // signature for caller backward-compat but not threaded into Cardsight
  // pricing (which returns the full record set; caller slices).
  void limit;
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

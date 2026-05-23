/**
 * Routing layer for Card Hedge -> Cardsight migration. Mode controlled by CARDSIGHT_MODE env var.
 * Engine code does not see mode; only routed result. See ADR-cardsight-migration-2026-05-18.md.
 *
 * Modes: "off" | "shadow" | "primary" | "exclusive"
 *
 * Log event vocabulary:
 *   - "shadow_comparison"
 *   - "shadow_search_comparison"
 *   - "shadow_pricing_comparison"
 *   - "shadow_pricing_skipped_namespace_check"
 *   - "shape_mapping_field_missing" (debug)
 *   - "primary_mode_cardhedge_namespace_only" (warn)
 *   - "invalid_mode" (warn)
 *
 * Namespace constraint: All cardId values passed to getCardSalesRouted from
 * compiqEstimate.service.ts are Card Hedge IDs (cardIdSource: "cardhedge").
 * Cardsight pricing is never called for cardhedge IDs in this PR; shadow/
 * primary/exclusive modes skip cardsight and emit log events as specified.
 */

import {
  searchCards,
  getCardSales,
  findCompsByQuery,
  type CardHedgeCard,
  type CardHedgeSale,
} from "./cardhedge.client.js";
import { searchCatalog, getPricing, CardsightTimeoutError } from "./cardsight.client.js";
import { resolveCardId } from "./cardsight.mapper.js";
import { translateResponse } from "./cardsight.translator.js";

const log = {
  info: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "cardsight.router", ...fields }), fields),
  warn: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "cardsight.router", level: "warn", ...fields }), fields),
  debug: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "cardsight.router", level: "debug", ...fields }), fields),
};

type CardsightMode = "off" | "shadow" | "primary" | "exclusive";

type RoutedResult = {
  card: CardHedgeCard | null;
  sales: CardHedgeSale[];
  variantWarning: string[];
  aiCategory: string | null;
};

export type QueryContext = {
  playerName?: string;
  cardYear?: string | number;
  product?: string;
  parallel?: string;
  // Phase 2 v2 — defect #11: cardNumber threaded through so resolveCardId can
  // disambiguate via detail-probe AND so the LRU cache key includes it for
  // proper per-cardNumber cache entries. Without this field, parsed.cardNumber
  // from iOS displayLabels (post-defect-#8 fix) was silently dropped at the
  // router boundary.
  cardNumber?: string;
  gradeCompany?: string;
  gradeValue?: string;
};

export type FindCompsRoutedOptions = {
  grade?: string;
  limit?: number;
  gradeCompany?: string;
  gradeValue?: string;
  queryContext?: QueryContext;
};

function normalizeMode(value: string | undefined): CardsightMode {
  const raw = (value ?? "off").toLowerCase();
  if (raw === "off" || raw === "shadow" || raw === "primary" || raw === "exclusive") {
    return raw;
  }
  log.warn("invalid_mode", { mode: value ?? null, fallbackMode: "off" });
  return "off";
}

function summarize(result: RoutedResult, durationMs: number, hasError = false) {
  return {
    compsCount: result.sales.length,
    firstThreeTitles: result.sales.slice(0, 3).map((s) => s.title ?? ""),
    totalValueApprox:
      Math.round(result.sales.reduce((sum, s) => sum + (s.price ?? 0), 0) * 100) / 100,
    durationMs,
    hasError,
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, durationMs: Date.now() - start };
}

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

function csToChCard(cs: any): CardHedgeCard {
  const ch: CardHedgeCard = {
    card_id: cs.id,
    player: cs.player ?? undefined,
    set: cs.setName ?? undefined,
    year: cs.year ?? undefined,
    number: cs.number ?? undefined,
    title: cs.name ?? undefined,
    name: cs.name ?? undefined,
  };
  (["card_id", "player", "set", "year", "number", "title", "name"] as const).forEach((f) => {
    if (ch[f] == null) log.debug("shape_mapping_field_missing", { field: f, source: "cardsight", cardId: cs.id });
  });
  return ch;
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

    const pricing = await getPricing(mapped.cardId, {
      parallelId: mapped.parallelId ?? undefined,
    });

    const translated = translateResponse(pricing, {
      gradeCompany: opts.gradeCompany,
      gradeValue: opts.gradeValue,
    });

    const baseCard: CardHedgeCard = {
      card_id: mapped.cardId,
      title: pricing.card?.name ?? undefined,
      // Defect #7 fix: Cardsight's pricing.card object has no `player` field
      // (player name lives in `name`). Without the fallback, baseCard.player
      // is always undefined under Cardsight, and the CH-identity guard in
      // compiqEstimate.service.ts builds a haystack that's just `card.title`
      // — trip-prone for any player whose surname isn't in the title string
      // (which under Cardsight equals `pricing.card.name`, often just the
      // bare player name with no surname differentiation).
      player: pricing.card?.player ?? pricing.card?.name ?? undefined,
      set: pricing.card?.setName ?? undefined,
      year: pricing.card?.year ?? undefined,
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
  const mode = normalizeMode(process.env.CARDSIGHT_MODE);
  const chOpts = { grade: opts.grade, limit: opts.limit };

  if (mode === "off") {
    return findCompsByQuery(query, chOpts) as Promise<RoutedResult>;
  }

  if (mode === "exclusive") {
    try {
      return await findCompsViaCardsight(query, opts);
    } catch (err: any) {
      if (err instanceof CardsightTimeoutError) throw err;
      log.warn("cardsight_error", { mode, query, error: err?.message ?? String(err) });
      return emptyCardsightResult(["cardsight_error"]);
    }
  }

  if (mode === "primary") {
    try {
      const cardsight = await findCompsViaCardsight(query, opts);
      if (cardsight.sales.length > 0) return cardsight;
      return findCompsByQuery(query, chOpts) as Promise<RoutedResult>;
    } catch (err: any) {
      log.warn("cardsight_error", { mode, query, error: err?.message ?? String(err) });
      return findCompsByQuery(query, chOpts) as Promise<RoutedResult>;
    }
  }

  // shadow
  const [ch, cs] = await Promise.all([
    timed(() => findCompsByQuery(query, chOpts) as Promise<RoutedResult>)
      .then(({ result, durationMs }) => ({ result, durationMs, hasError: false, error: null as unknown }))
      .catch((err: unknown) => ({
        result: emptyCardsightResult(["cardhedge_error"]),
        durationMs: 0,
        hasError: true,
        error: err,
      })),
    timed(() => findCompsViaCardsight(query, opts))
      .then(({ result, durationMs }) => ({ result, durationMs, hasError: false, error: null as unknown }))
      .catch((err: unknown) => ({
        result: emptyCardsightResult(["cardsight_error"]),
        durationMs: 0,
        hasError: true,
        error: err,
      })),
  ]);

  log.info("shadow_comparison", {
    query: {
      playerName: opts.queryContext?.playerName ?? null,
      cardYear: opts.queryContext?.cardYear ?? null,
      product: opts.queryContext?.product ?? null,
      parallel: opts.queryContext?.parallel ?? null,
      gradeCompany: opts.gradeCompany ?? opts.queryContext?.gradeCompany ?? null,
      gradeValue: opts.gradeValue ?? opts.queryContext?.gradeValue ?? null,
    },
    cardhedge: summarize(ch.result, ch.durationMs, ch.hasError),
    cardsight: summarize(cs.result, cs.durationMs, cs.hasError),
    selectedSource: "card_hedge",
  });

  if (ch.hasError && ch.error) throw ch.error;
  if (cs.hasError && cs.error) {
    log.warn("cardsight_error", {
      mode,
      query,
      error: (cs.error as any)?.message ?? String(cs.error),
    });
  }

  return ch.result;
}

// ── searchCardsRouted ───────────────────────────────────────────────────────

export async function searchCardsRouted(
  query: string,
  limit: number = 20,
): Promise<CardHedgeCard[]> {
  const mode = normalizeMode(process.env.CARDSIGHT_MODE);
  if (mode === "off") {
    return searchCards(query, limit);
  }
  if (mode === "exclusive") {
    const cs = await searchCatalog(query, { take: limit });
    return cs.map(csToChCard);
  }
  if (mode === "primary") {
    const cs = await searchCatalog(query, { take: limit });
    if (cs.length > 0) return cs.map(csToChCard);
    return searchCards(query, limit);
  }
  // shadow
  const [ch, cs] = await Promise.all([
    timed(() => searchCards(query, limit))
      .then(({ result, durationMs }) => ({ result, durationMs, hasError: false, error: null as unknown }))
      .catch((err: unknown) => ({ result: [] as CardHedgeCard[], durationMs: 0, hasError: true, error: err })),
    timed(() => searchCatalog(query, { take: limit }))
      .then(({ result, durationMs }) => ({ result, durationMs, hasError: false, error: null as unknown }))
      .catch((err: unknown) => ({ result: [] as any[], durationMs: 0, hasError: true, error: err })),
  ]);
  log.info("shadow_search_comparison", {
    query,
    cardhedge: {
      count: ch.result.length,
      firstThree: ch.result.slice(0, 3).map((c: any) => c.title ?? c.name ?? ""),
    },
    cardsight: {
      count: cs.result.length,
      firstThree: cs.result.slice(0, 3).map((c: any) => c.name ?? ""),
    },
    durationMs: { cardhedge: ch.durationMs, cardsight: cs.durationMs },
    hasError: { cardhedge: ch.hasError, cardsight: cs.hasError },
  });
  if (ch.hasError && ch.error) throw ch.error;
  return ch.result;
}

// ── getCardSalesRouted ──────────────────────────────────────────────────────

export async function getCardSalesRouted(
  cardId: string,
  grade: string,
  limit: number,
  opts?: { cardIdSource?: "cardhedge" | "cardsight" },
): Promise<CardHedgeSale[]> {
  const mode = normalizeMode(process.env.CARDSIGHT_MODE);
  const cardIdSource = opts?.cardIdSource ?? "cardhedge";

  async function cardsightSales(): Promise<CardHedgeSale[]> {
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

  if (mode === "off") {
    return getCardSales(cardId, grade, limit);
  }
  if (mode === "shadow") {
    if (cardIdSource === "cardhedge") {
      log.info("shadow_pricing_skipped_namespace_check", {
        reason: "cardId_is_cardhedge_namespace",
        cardId,
      });
      return getCardSales(cardId, grade, limit);
    }
    log.info("shadow_pricing_comparison", { cardId, cardIdSource, singleSource: "cardsight" });
    return cardsightSales();
  }
  if (mode === "primary") {
    if (cardIdSource === "cardhedge") {
      log.warn("primary_mode_cardhedge_namespace_only", { cardId });
      return getCardSales(cardId, grade, limit);
    }
    return cardsightSales();
  }
  // exclusive
  if (cardIdSource === "cardhedge") {
    log.warn("primary_mode_cardhedge_namespace_only", { cardId });
    return [];
  }
  return cardsightSales();
}

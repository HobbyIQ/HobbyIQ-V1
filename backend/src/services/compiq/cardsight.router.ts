/**
 * Routing layer for Card Hedge -> Cardsight migration. Mode controlled by CARDSIGHT_MODE env var.
 * Engine code does not see mode; only routed result. See ADR-cardsight-migration-2026-05-18.md PR #4.
 */

import { createLogger } from "../../lib/logger.js";
import { findCompsByQuery, type CardHedgeCard, type CardHedgeSale } from "./cardhedge.client.js";
import { resolveCardId } from "./cardsight.mapper.js";
import { getPricing, CardsightTimeoutError } from "./cardsight.client.js";
import { translateResponse } from "./cardsight.translator.js";

type CardsightMode = "off" | "shadow" | "primary" | "exclusive";

const log = createLogger("cardsight.router");

type RoutedResult = {
  card: CardHedgeCard | null;
  sales: CardHedgeSale[];
  variantWarning: string[];
  aiCategory: string | null;
};

type QueryContext = {
  playerName?: string;
  cardYear?: string | number;
  product?: string;
  parallel?: string;
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
    totalValueApprox: Math.round(result.sales.reduce((sum, s) => sum + (s.price ?? 0), 0) * 100) / 100,
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

async function findCompsViaCardsight(
  query: string,
  opts: FindCompsRoutedOptions,
): Promise<RoutedResult> {
  const mapped = await resolveCardId(toCardsightQuery(query, opts));
  if (!mapped.cardId) {
    return emptyCardsightResult(["cardsight_no_catalog_match", ...mapped.warnings]);
  }

  const pricing = await getPricing(mapped.cardId, {
    parallelId: mapped.parallelId ?? undefined,
  });

  const translated = translateResponse(pricing, {
    gradeCompany: opts.gradeCompany,
    gradeValue: opts.gradeValue,
  });

  if (translated.length === 0) {
    return {
      card: {
        card_id: mapped.cardId,
        title: pricing.card?.name ?? null,
        player: pricing.card?.player ?? null,
        set: pricing.card?.setName ?? null,
        year: pricing.card?.year ?? null,
        number: pricing.card?.number ?? null,
        variant: mapped.parallelId ?? null,
      },
      sales: [],
      variantWarning: ["cardsight_no_pricing_data", ...mapped.warnings],
      aiCategory: null,
    };
  }

  return {
    card: {
      card_id: mapped.cardId,
      title: pricing.card?.name ?? null,
      player: pricing.card?.player ?? null,
      set: pricing.card?.setName ?? null,
      year: pricing.card?.year ?? null,
      number: pricing.card?.number ?? null,
      variant: mapped.parallelId ?? null,
    },
    sales: translated.map((s) => ({
      title: s.title,
      price: s.price,
      date: s.soldDate,
      grade: opts.grade ?? "Raw",
      source: "cardsight",
      sale_type: null,
      url: null,
    })) as CardHedgeSale[],
    variantWarning: mapped.warnings,
    aiCategory: null,
  };
}

export async function findCompsRouted(
  query: string,
  opts: FindCompsRoutedOptions = {},
): Promise<RoutedResult> {
  const mode = normalizeMode(process.env.CARDSIGHT_MODE);
  const chOpts = { grade: opts.grade, limit: opts.limit };

  if (mode === "off") {
    return findCompsByQuery(query, chOpts);
  }

  if (mode === "exclusive") {
    try {
      return await findCompsViaCardsight(query, opts);
    } catch (err: any) {
      if (err instanceof CardsightTimeoutError) throw err;
      log.warn("cardsight_error", {
        mode,
        query,
        error: err?.message ?? String(err),
      });
      return emptyCardsightResult(["cardsight_error"]);
    }
  }

  if (mode === "primary") {
    try {
      const cardsight = await findCompsViaCardsight(query, opts);
      if (cardsight.sales.length > 0) return cardsight;
      return findCompsByQuery(query, chOpts);
    } catch (err: any) {
      log.warn("cardsight_error", {
        mode,
        query,
        error: err?.message ?? String(err),
      });
      return findCompsByQuery(query, chOpts);
    }
  }

  const [ch, cs] = await Promise.all([
    timed(() => findCompsByQuery(query, chOpts))
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

  if (ch.hasError && ch.error) {
    throw ch.error;
  }

  if (cs.hasError && cs.error) {
    log.warn("cardsight_error", {
      mode,
      query,
      error: (cs.error as any)?.message ?? String(cs.error),
    });
  }

  return ch.result;
}

/**
 * Cardsight ID resolver (mapper). Phase 1 of migration per ADR-cardsight-migration-2026-05-18.
 *
 * Translates CompIQ internal query inputs (product names, parallels, etc.) to
 * Cardsight catalog card IDs and parallel IDs using the Cardsight catalog API.
 *
 * Resolution strategy:
 *  1. Build combined query: `{playerName} {cardsightReleaseName}` using the release dictionary
 *  2. Call searchCatalog with year + segment=baseball
 *  3. Filter results by setName pattern match
 *  4. If parallel requested, call getCardDetail to resolve parallelId
 */

import { searchCatalog, getCardDetail } from "./cardsight.client.js";
import type { CardsightCatalogResult } from "./cardsight.client.js";

const log = {
  warn: (event: string, fields: Record<string, unknown> = {}) =>
    console.warn(JSON.stringify({ event, source: "cardsight.mapper", ...fields })),
};

export interface CompIQQueryInput {
  playerName: string;
  cardYear?: string | number;
  product?: string;
  parallel?: string;
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
  "bowman chrome": "Bowman Draft Chrome",
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

function lookupReleaseName(product: string): string | null {
  if (!product) return null;
  const normalized = product.toLowerCase().trim();
  return COMPIQ_TO_CARDSIGHT_RELEASES[normalized] ?? null;
}

function tokenizeParallel(name: string): string[] {
  return name
    .split(/[\s\-/]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

function parallelMatches(input: string, candidate: string): boolean {
  const inputTokens = tokenizeParallel(input);
  const candidateTokens = tokenizeParallel(candidate);
  return inputTokens.every((t) => candidateTokens.includes(t));
}

export async function resolveCardId(
  input: CompIQQueryInput,
): Promise<CardsightResolution> {
  const warnings: string[] = [];

  let releaseName: string | null = input.product ? lookupReleaseName(input.product) : null;
  if (input.product && !releaseName) {
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
  if (releaseName) {
    const releaseFiltered = results.filter(
      (r) => r.releaseName?.toLowerCase() === releaseName!.toLowerCase(),
    );
    if (releaseFiltered.length > 0) candidates = releaseFiltered;
    else {
      log.warn("catalog_no_match", {
        query,
        releaseName,
        reason: "release_name_filter",
        endpoint: "resolveCardId",
      });
      warnings.push(
        `No results matched release "${releaseName}" — using top-ranked result.`,
      );
    }
  }

  if (input.product) {
    const patternKey = Object.keys(CARDSIGHT_SET_PATTERNS).find((k) =>
      k.toLowerCase().includes(input.product!.toLowerCase()),
    );
    if (patternKey) {
      const pattern = CARDSIGHT_SET_PATTERNS[patternKey];
      const setFiltered = candidates.filter((r) => pattern.test(r.setName ?? ""));
      if (setFiltered.length > 0) candidates = setFiltered;
      else {
        log.warn("catalog_no_match", {
          query,
          patternKey,
          reason: "set_name_filter",
          endpoint: "resolveCardId",
        });
      }
    }
  }

  const isSingleExact = candidates.length === 1;
  const topCard = candidates[0];

  if (candidates.length > 1) {
    log.warn("catalog_ambiguous_match", {
      query,
      candidateCount: candidates.length,
      selectedCardId: topCard.id,
      endpoint: "resolveCardId",
    });
    warnings.push(
      `${candidates.length} catalog candidates returned — using top-ranked (id=${topCard.id}, set="${topCard.setName}").`,
    );
  }

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

  const matchConfidence = isSingleExact && candidates.length === 1 ? "exact" : "likely";

  return {
    cardId: topCard.id,
    parallelId,
    matchConfidence,
    warnings,
  };
}

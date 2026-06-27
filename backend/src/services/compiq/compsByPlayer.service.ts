/**
 * Player+product comp aggregation endpoint backing MCP's compsLoader.
 *
 * CH-restoration rewrite (2026-06-26): now sources comps from Card Hedge
 * directly (searchCards → top-K → getCardSales). The MCP loader contract is
 * preserved exactly — same exports, same response shape — so no MCP-side
 * changes are required when this swap lands.
 *
 * Endpoint contract (see route in compiq.routes.ts):
 *   GET /api/compiq/comps-by-player?playerName=...&product=...&cardYear=...
 *     &parallel=...&gradeCompany=...&gradeValue=...
 *   →  CompsByPlayerResponse
 *
 * Pricing engine separation: this service emits RAW sale records ONLY.
 * Predicted pricing remains the responsibility of the MCP /predict pipeline
 * (signals + floor + anchor + OpenAI). We never compute or return a price
 * prediction here.
 */

import { cacheGet, cacheSet } from "../shared/cache.service.js";
import {
  searchCards,
  getCardSales,
  type CardHedgeCard,
  type CardHedgeSale,
} from "./cardhedge.client.js";

const log = {
  info: (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event, source: "compsByPlayer.service", ...fields })),
  warn: (event: string, fields: Record<string, unknown> = {}) =>
    console.warn(JSON.stringify({ event, source: "compsByPlayer.service", ...fields })),
};

// 6h aggregate TTL — matches the prior implementation and the underlying
// CH per-cardId comps TTL (12h) so the aggregate never outlives its inputs
// by more than its own window.
const AGGREGATE_TTL_SECONDS = 6 * 3600;

// Worst-case CH fan-out per cache-miss: 1 searchCards + ≤MAX_PRICING_PROBES
// getCardSales. CH per-card comps TTL is 12h so a second hit within the
// window costs zero CH calls.
const MAX_PRICING_PROBES = 8;

const SEARCH_TAKE = 25;
const COMPS_PER_CARD = 25;

export interface CompsByPlayerInput {
  playerName: string;
  product: string;
  cardYear?: number;
  parallel?: string;
  gradeCompany?: string;
  gradeValue?: string | number;
}

export interface CompByPlayer {
  cardId: string;
  price: number;
  date: string;
  title: string;
  source: "cardhedge";
}

export interface CompsByPlayerResponse {
  player: string;
  product: string;
  cardYear?: number;
  cardIds: string[];
  comps: CompByPlayer[];
  cached: boolean;
  /** ms since the cached entry was written; only set when cached=true. */
  cacheAge?: number;
  warnings: string[];
}

interface CachedEntry {
  cachedAt: number;
  player: string;
  product: string;
  cardYear?: number;
  cardIds: string[];
  comps: CompByPlayer[];
  warnings: string[];
}

function buildCacheKey(input: CompsByPlayerInput): string {
  return [
    "compsByPlayer:v2:ch",
    input.playerName.toLowerCase().trim().replace(/\s+/g, " "),
    input.product.toLowerCase().trim().replace(/\s+/g, " "),
    String(input.cardYear ?? ""),
    (input.parallel ?? "").toLowerCase().trim(),
    (input.gradeCompany ?? "").toLowerCase().trim(),
    String(input.gradeValue ?? "").trim(),
  ].join("|");
}

function buildSearchQuery(input: CompsByPlayerInput): string {
  const parts = [
    input.cardYear ? String(input.cardYear) : "",
    input.product.trim(),
    input.playerName.trim(),
    (input.parallel ?? "").trim(),
  ].filter(Boolean);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function buildGradeLabel(input: CompsByPlayerInput): string {
  const company = (input.gradeCompany ?? "").trim().toUpperCase();
  const value = String(input.gradeValue ?? "").trim();
  if (!company || !value) return "Raw";
  return `${company} ${value}`;
}

function yearMatchesInput(card: CardHedgeCard, cardYear?: number): boolean {
  if (cardYear === undefined) return true;
  const ny = Number(card.year);
  if (!Number.isFinite(ny)) return true; // unknown year ⇒ don't drop
  return ny === cardYear;
}

function productMatchesInput(card: CardHedgeCard, product: string): boolean {
  if (!product) return true;
  const setText = (card.set ?? "").toLowerCase();
  const productLc = product.toLowerCase();
  // Tokenized inclusion — every word in the product hint must appear in the
  // card's set string. Lenient enough to handle "Topps Chrome Update" vs
  // "2024 Topps Chrome Update Baseball" but strict enough to reject
  // "Topps Update" when the user asked for "Topps Chrome Update".
  return productLc.split(/\s+/).every((tok) => setText.includes(tok));
}

function parallelMatchesInput(card: CardHedgeCard, parallel?: string): boolean {
  if (!parallel || !parallel.trim()) return true;
  const want = parallel.toLowerCase().trim();
  const blob = `${card.variant ?? ""} ${card.set ?? ""} ${card.title ?? ""} ${card.name ?? ""}`.toLowerCase();
  return blob.includes(want);
}

/**
 * Aggregate player+product comps from Card Hedge.
 *
 * Flow: searchCards → filter by year/product/parallel → take top
 * MAX_PRICING_PROBES candidates → getCardSales per candidate → flatten,
 * dedupe by (title|date|price), sort by date desc.
 *
 * Failure handling: empty search returns empty comps with a warning (NOT
 * cached); per-candidate comp errors are tolerated and skipped with a
 * warning. CH API key missing or top-level errors propagate.
 */
export async function fetchCompsByPlayer(
  input: CompsByPlayerInput,
): Promise<CompsByPlayerResponse> {
  const cacheKey = buildCacheKey(input);

  // Cache hit path
  const cachedJson = await cacheGet(cacheKey);
  if (cachedJson !== null) {
    try {
      const cached = JSON.parse(cachedJson) as CachedEntry;
      const cacheAge = Date.now() - cached.cachedAt;
      log.info("aggregate_cache_hit", {
        cacheKey,
        cacheAgeMs: cacheAge,
        compsCount: cached.comps.length,
      });
      return {
        player: cached.player,
        product: cached.product,
        ...(cached.cardYear !== undefined ? { cardYear: cached.cardYear } : {}),
        cardIds: cached.cardIds,
        comps: cached.comps,
        cached: true,
        cacheAge,
        warnings: cached.warnings,
      };
    } catch {
      log.warn("aggregate_cache_parse_failed", { cacheKey });
    }
  }

  const start = Date.now();
  const warnings: string[] = [];
  const grade = buildGradeLabel(input);
  const query = buildSearchQuery(input);

  if (!query) {
    warnings.push("Empty search query — playerName and product both required.");
    return {
      player: input.playerName,
      product: input.product,
      ...(input.cardYear !== undefined ? { cardYear: input.cardYear } : {}),
      cardIds: [],
      comps: [],
      cached: false,
      warnings,
    };
  }

  const searchResults = await searchCards(query, SEARCH_TAKE);

  if (searchResults.length === 0) {
    warnings.push(`No Card Hedge search results for query "${query}".`);
    log.warn("aggregate_search_empty", {
      playerName: input.playerName,
      product: input.product,
      cardYear: input.cardYear ?? null,
      query,
    });
    return {
      player: input.playerName,
      product: input.product,
      ...(input.cardYear !== undefined ? { cardYear: input.cardYear } : {}),
      cardIds: [],
      comps: [],
      cached: false,
      warnings,
    };
  }

  // Filter pass: drop year/product mismatches and parallel mismatches.
  let candidates = searchResults
    .filter((c) => yearMatchesInput(c, input.cardYear))
    .filter((c) => productMatchesInput(c, input.product))
    .filter((c) => parallelMatchesInput(c, input.parallel));

  if (candidates.length === 0) {
    // Fallback: ignore parallel filter (CH variant field is unreliable) but
    // keep year+product. This mirrors the prior implementation's
    // setName-fallback behavior.
    candidates = searchResults
      .filter((c) => yearMatchesInput(c, input.cardYear))
      .filter((c) => productMatchesInput(c, input.product));
    if (candidates.length > 0) {
      warnings.push(
        `No exact parallel matches for "${input.parallel}" — falling back to year+product candidates.`,
      );
    }
  }

  if (candidates.length === 0) {
    warnings.push(
      `Search returned ${searchResults.length} results but none matched year=${input.cardYear ?? "*"} product="${input.product}".`,
    );
    log.warn("aggregate_filter_no_match", {
      query,
      searchCount: searchResults.length,
      cardYear: input.cardYear ?? null,
      product: input.product,
    });
    // Don't cache filter-misses — give CH a chance to widen on next call.
    return {
      player: input.playerName,
      product: input.product,
      ...(input.cardYear !== undefined ? { cardYear: input.cardYear } : {}),
      cardIds: [],
      comps: [],
      cached: false,
      warnings,
    };
  }

  // Top-K per-card comp fetch. Failures per-candidate are tolerated.
  const probeSet = candidates.slice(0, MAX_PRICING_PROBES);
  const compResults = await Promise.all(
    probeSet.map(async (c) => {
      try {
        return await getCardSales(c.card_id, grade, COMPS_PER_CARD);
      } catch (err: any) {
        log.warn("aggregate_comp_probe_failed", {
          cardId: c.card_id,
          query,
          error: err?.message ?? String(err),
        });
        return [] as CardHedgeSale[];
      }
    }),
  );

  // Aggregate + dedupe. Dedupe key: title|date|price.
  const cardIds: string[] = [];
  const comps: CompByPlayer[] = [];
  const seenSales = new Set<string>();
  for (let i = 0; i < probeSet.length; i++) {
    const candidate = probeSet[i];
    const sales = compResults[i] ?? [];
    if (sales.length === 0) continue;
    cardIds.push(candidate.card_id);

    for (const s of sales) {
      if (s.price <= 0) continue;
      const title =
        s.title ??
        [candidate.year, candidate.set, candidate.player, candidate.number, candidate.variant]
          .filter(Boolean)
          .join(" ");
      const dedupKey = `${title}|${s.date ?? ""}|${s.price}`;
      if (seenSales.has(dedupKey)) continue;
      seenSales.add(dedupKey);
      comps.push({
        cardId: candidate.card_id,
        price: s.price,
        date: s.date ?? "",
        title,
        source: "cardhedge",
      });
    }
  }

  // Sort by date desc; empty dates sink.
  comps.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });

  const entry: CachedEntry = {
    cachedAt: Date.now(),
    player: input.playerName,
    product: input.product,
    ...(input.cardYear !== undefined ? { cardYear: input.cardYear } : {}),
    cardIds,
    comps,
    warnings,
  };
  if (cardIds.length > 0) {
    await cacheSet(cacheKey, JSON.stringify(entry), AGGREGATE_TTL_SECONDS);
  }

  log.info("aggregate_cache_miss", {
    cacheKey,
    cardCount: cardIds.length,
    compsCount: comps.length,
    elapsedMs: Date.now() - start,
  });

  return {
    player: input.playerName,
    product: input.product,
    ...(input.cardYear !== undefined ? { cardYear: input.cardYear } : {}),
    cardIds,
    comps,
    cached: false,
    warnings,
  };
}

// ───── Cache warming at startup ──────────────────────────────────────────────
//
// Demo-relevant warm targets. Serialized to stay under CH rate-limit
// headroom (~120 req/min on shared key per CF-CACHE-WARM-SERIAL).
// Startup cost ~10 targets × ~2s cold ≈ ~20s — fire-and-forget; /health
// stays responsive immediately.

const CACHE_WARM_TARGETS: ReadonlyArray<
  Pick<CompsByPlayerInput, "playerName" | "product" | "cardYear">
> = [
  { playerName: "Mike Trout", cardYear: 2011, product: "Topps Update" },
  { playerName: "Aaron Judge", cardYear: 2017, product: "Topps Update" },
  { playerName: "Cody Bellinger", cardYear: 2017, product: "Topps Update" },
  { playerName: "Shohei Ohtani", cardYear: 2018, product: "Topps Update" },
  { playerName: "Ronald Acuna Jr", cardYear: 2018, product: "Topps Update" },
  { playerName: "Juan Soto", cardYear: 2018, product: "Topps Update" },
  { playerName: "Gleyber Torres", cardYear: 2018, product: "Topps Update" },
  { playerName: "Bobby Witt Jr", cardYear: 2022, product: "Topps Chrome Update" },
  { playerName: "Paul Skenes", cardYear: 2024, product: "Topps Chrome Update" },
  { playerName: "Caleb Bonemer", cardYear: 2024, product: "Bowman Draft Chrome" },
];

export async function warmCompsByPlayerCache(): Promise<void> {
  const start = Date.now();
  let primed = 0;
  let failed = 0;
  for (const target of CACHE_WARM_TARGETS) {
    try {
      const result = await fetchCompsByPlayer(target);
      if (result.cardIds.length > 0) primed++;
      else failed++;
    } catch (err: any) {
      failed++;
      log.warn("warm_target_failed", {
        target: target.playerName,
        product: target.product,
        cardYear: target.cardYear,
        error: err?.message ?? String(err),
      });
    }
  }
  log.info("compsByPlayer_cache_warmed", {
    primed,
    failed,
    targets: CACHE_WARM_TARGETS.length,
    elapsedMs: Date.now() - start,
  });
}

// Test-only internal accessors.
export const __compsByPlayerInternals = {
  buildCacheKey,
  buildSearchQuery,
  buildGradeLabel,
  AGGREGATE_TTL_SECONDS,
  MAX_PRICING_PROBES,
  CACHE_WARM_TARGETS,
};

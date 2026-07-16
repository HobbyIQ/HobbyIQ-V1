// CF-CS-STRUCTURED-BRIDGE (Drew, 2026-07-15): symmetric with the CH
// structured bridge (PR #466). Bypass CS's fuzzy `fetchCardsightUuidNativeCandidates`
// + local scoring dance when we already have identity (playerName +
// cardNumber). Hits CS's /v1/catalog/cards structured endpoint, filters
// results locally, picks the exact parallel, calls /v1/pricing/{id}
// for comps.
//
// Wins over the fuzzy fallback path in two ways:
//   1. No candidate-explosion + local-scoring — direct field filter
//   2. cardNumber-anchored — no risk of picking wrong player when CS's
//      searchCatalog returns adjacent matches
//
// Same pattern & confidence framing as CH-side structured bridge.

import type { CardIdentityHint, RoutedResult, RoutedSale, RoutedCard } from "./cardsight.router.js";
import {
  getCatalogCards,
  getPricing,
  isCardsightConfigured,
  type CardsightCardSummary,
  type CardsightPricingResponse,
  type CardsightSaleRecord,
} from "./cardsightSlim.client.js";

const log = (event: string, fields: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ event, source: "cardsightStructuredBridge", ...fields }));
};

const SEARCH_TAKE = 30;

/**
 * Select graded records matching the requested grade string. Same helper
 * shape as cardsightFallback.ts — kept local for module cohesion.
 */
function selectGradedRecords(pricing: CardsightPricingResponse, grade: string): CardsightSaleRecord[] {
  const parts = grade.trim().split(/\s+/);
  if (parts.length < 2) return [];
  const wantCompany = parts[0].toUpperCase();
  const wantValue = parts.slice(1).join(" ");
  for (const co of pricing.graded ?? []) {
    if ((co.company_name ?? "").toUpperCase() !== wantCompany) continue;
    for (const g of co.grades ?? []) {
      if ((g.grade_value ?? "").toString() === wantValue) return g.records ?? [];
    }
  }
  return [];
}

/**
 * Score a CardSummary candidate against identity. Similar shape to
 * cardHedgeStructuredBridge — number match is required, year/parallel
 * narrow further.
 */
function pickBestCandidate(
  candidates: CardsightCardSummary[],
  identity: CardIdentityHint,
): CardsightCardSummary | null {
  const wantNumber = identity.number?.trim().toLowerCase();
  if (!wantNumber) return null;
  const wantYear = typeof identity.cardYear === "number"
    ? identity.cardYear
    : identity.cardYear != null ? parseInt(String(identity.cardYear), 10) : null;

  // Filter by exact card number
  const numberMatches = candidates.filter(
    (c) => String(c.number ?? "").trim().toLowerCase() === wantNumber,
  );
  if (numberMatches.length === 0) return null;

  // Narrow by year (soft — if 0 matches, keep number-only pool)
  let pool = numberMatches;
  if (wantYear != null && Number.isFinite(wantYear)) {
    const yearMatches = numberMatches.filter((c) => {
      const cy = parseInt(String(c.releaseYear ?? ""), 10);
      return Number.isFinite(cy) && cy === wantYear;
    });
    if (yearMatches.length > 0) pool = yearMatches;
  }

  return pool[0] ?? null;
}

/**
 * Pick a parallelId from the candidate's inline parallels[] tree that
 * matches identity.parallel. Returns null when parallel unknown OR no
 * matching parallel — caller can fall back to base-card pricing (no
 * parallelId filter).
 */
function pickParallelId(candidate: CardsightCardSummary, identityParallel: string | undefined): string | null {
  if (!identityParallel || !candidate.parallels?.length) return null;
  const want = identityParallel.trim().toLowerCase();
  // Prefer exact match
  const exact = candidate.parallels.find((p) => p.name.trim().toLowerCase() === want);
  if (exact) return exact.id;
  // Then longest partial match (candidate parallel contains want, or vice versa)
  let best: { p: typeof candidate.parallels[number]; score: number } | null = null;
  for (const p of candidate.parallels) {
    const pn = p.name.trim().toLowerCase();
    if (pn.includes(want) || want.includes(pn)) {
      const score = Math.min(pn.length, want.length);
      if (!best || score > best.score) best = { p, score };
    }
  }
  return best?.p.id ?? null;
}

/**
 * Structured CS bridge — CS-side analog of CH's structured bridge. Fires
 * only when we have playerName + cardNumber. Env-gated on
 * CARDSIGHT_STRUCTURED_BRIDGE_ENABLED=true.
 */
export async function tryCardsightStructuredBridge(
  identity: CardIdentityHint,
  grade: string,
): Promise<RoutedResult | null> {
  if (process.env.CARDSIGHT_STRUCTURED_BRIDGE_ENABLED !== "true") return null;
  if (!isCardsightConfigured()) return null;

  const player = identity.playerName?.trim();
  if (!player || player.length < 2) return null;
  const wantNumber = identity.number?.trim();
  if (!wantNumber) return null;

  const wantYear = typeof identity.cardYear === "number"
    ? identity.cardYear
    : identity.cardYear != null ? parseInt(String(identity.cardYear), 10) : null;

  const start = Date.now();
  let candidates: CardsightCardSummary[];
  try {
    candidates = await getCatalogCards({
      name: player,
      number: wantNumber,
      year: wantYear ?? undefined,
      take: SEARCH_TAKE,
    });
  } catch (err) {
    log("cs_structured.search_error", {
      player,
      wantNumber,
      error: (err as Error)?.message ?? String(err),
    });
    return null;
  }
  if (candidates.length === 0) {
    log("cs_structured.no_candidates", { player, wantNumber, wantYear });
    return null;
  }

  const winner = pickBestCandidate(candidates, identity);
  if (!winner) {
    log("cs_structured.no_winner", {
      player,
      wantNumber,
      wantYear,
      candidateCount: candidates.length,
    });
    return null;
  }

  const parallelId = pickParallelId(winner, identity.parallel);
  // If we specified a parallel but couldn't find it in the tree, that
  // means the base card exists but this specific variant isn't in CS's
  // catalog. Better to return null than fetch base pricing (wrong sub-
  // market). Fall through to CS-fallback or backstop.
  if (identity.parallel && identity.parallel.trim() && !parallelId) {
    log("cs_structured.parallel_not_in_tree", {
      cardId: winner.id,
      wantParallel: identity.parallel,
      availableParallels: (winner.parallels ?? []).map((p) => p.name),
    });
    return null;
  }

  let pricing: CardsightPricingResponse;
  try {
    pricing = await getPricing(winner.id, parallelId ? { parallelId } : {});
  } catch (err) {
    log("cs_structured.pricing_error", {
      cardId: winner.id,
      parallelId,
      error: (err as Error)?.message ?? String(err),
    });
    return null;
  }

  const gradeUp = grade.trim().toUpperCase();
  const isRaw = gradeUp === "RAW" || gradeUp === "";
  const records: CardsightSaleRecord[] = isRaw
    ? (pricing.raw?.records ?? [])
    : selectGradedRecords(pricing, grade);

  const sales: RoutedSale[] = records
    .filter((r) => Number.isFinite(r.price) && r.price > 0 && !!r.date)
    .map((r) => ({
      price: r.price,
      date: r.date,
      grade: isRaw ? "Raw" : grade,
      source: "cardsight",
      sale_type: r.listing_type ?? null,
      title: r.title ?? null,
      url: r.url ?? null,
      listing_type: r.listing_type ?? null,
      image_url: r.image_url ?? null,
    }) as RoutedSale);

  if (sales.length === 0) {
    log("cs_structured.no_sales_after_filter", {
      cardId: winner.id,
      parallelId,
      grade,
      rawCount: pricing.raw?.count ?? 0,
    });
    return null;
  }

  const parallelName = winner.parallels?.find((p) => p.id === parallelId)?.name ?? identity.parallel;
  // CF-CARDSIGHT-STRUCTURED-TITLE (audit PR #492, 2026-07-15): synthesize
  // a display title so the pinned card-meta cache
  // (cardsight.router.ts:930-937 cacheCardMeta) has something to persist
  // when only StructuredBridge served. Without this, a subsequent
  // /price-by-id request would land on a card-meta record with no title,
  // breaking iOS hero rendering + downstream title-token matching. Fmt
  // matches how compiqEstimate.service.ts:2620 rebuilds titles from a
  // parent-card record ([year, product, player, number, variant].join).
  const synthesizedTitle = [
    winner.releaseYear ?? identity.cardYear,
    winner.releaseName ?? winner.setName ?? identity.product,
    winner.name ?? identity.playerName,
    winner.number ?? identity.number,
    parallelName,
  ]
    .filter((v) => v != null && String(v).trim().length > 0)
    .join(" ");
  const card: RoutedCard = {
    card_id: parallelId ? `cardsight:${winner.id}::${parallelId}` : `cardsight:${winner.id}`,
    player: winner.name ?? identity.playerName,
    set: winner.setName ?? identity.product,
    year: winner.releaseYear ?? identity.cardYear,
    number: winner.number ?? identity.number,
    variant: parallelName,
    title: synthesizedTitle.length > 0 ? synthesizedTitle : undefined,
    // NOTE: imageUrl not populated here — CardsightCardSummary doesn't
    // carry image info. A follow-up PR can add a detail fetch to
    // /v1/catalog/cards/{id} + populate imageUrl, but that adds an HTTP
    // call to the structured path. iOS falls back to the /card-image-
    // proxy stack when imageUrl is absent.
  };

  log("cs_structured.served", {
    cardId: winner.id,
    parallelId,
    parallelName,
    salesCount: sales.length,
    grade,
    latency_ms: Date.now() - start,
  });

  return {
    card,
    sales,
    variantWarning: [],
    aiCategory: null,
  };
}

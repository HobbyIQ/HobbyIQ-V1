// CF-CARDSIGHT-FALLBACK-REVIVAL (Drew, 2026-07-14): reverse the June 2026
// Wave 3 decommission for a narrow, targeted case — when CardHedge has NO
// bridge/identity match for a query (i.e. the CH catalog literally lacks the
// SKU), fall through to Cardsight for identity + comps.
//
// Rationale: CH-primary was chosen because CH's trust-guard rejected many
// CS results as low-quality (blob signatures, thin data). That rationale
// still holds when CH HAS a match — we don't want to override CH's
// authoritative pricing with worse CS data. But when CH returns nothing at
// all (real cards like Eric Hartman Blue Refractor Auto CPA-EHA that CH's
// catalog just doesn't include), returning empty is strictly worse than
// asking CS. The user's alternative — pricing on empty comps — falls back
// to sibling-pool synthesis and produces wildly wrong numbers ($10 for a
// $1800 card).
//
// TRUST BOUNDARY: sales returned here are stamped source="cardsight" and
// will be labeled routedVendor="cardsight" in fetchComps' output. Downstream
// telemetry + the sold_comps ingest helper both key on this label — CS
// comps land in the pool at confidence=0.6 (vs CH's 0.8), matching the
// existing confidence hierarchy in project_sold_comps_unified_pool.md.

import type { CardIdentityHint, RoutedResult, RoutedSale, RoutedCard } from "./cardsight.router.js";
import {
  fetchCardsightUuidNativeCandidates,
} from "./cardsightUuidSource.js";
import {
  getPricing,
  isCardsightConfigured,
  type CardsightPricingResponse,
  type CardsightSaleRecord,
} from "./cardsightSlim.client.js";

const log = (event: string, fields: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ event, source: "cardsightFallback", ...fields }));
};

/**
 * Parse a compound cardId of the form `cardsight:{parentId}::{parallelId}`
 * back into its two component UUIDs. Returns null when the shape doesn't
 * match — defensive against future changes to cardsightUuidSource format.
 */
function parseCsCandidateId(candidateId: string): { parentId: string; parallelId: string } | null {
  const stripped = candidateId.startsWith("cardsight:") ? candidateId.slice("cardsight:".length) : candidateId;
  const sep = stripped.indexOf("::");
  if (sep <= 0 || sep >= stripped.length - 2) return null;
  const parentId = stripped.slice(0, sep);
  const parallelId = stripped.slice(sep + 2);
  if (!parentId || !parallelId) return null;
  return { parentId, parallelId };
}

/**
 * Score a CS candidate against the identity hint. Higher = better match.
 * Requires at least playerName + year to align (returns null otherwise) so
 * an unrelated CS candidate doesn't get returned when CH had no bridge.
 */
function scoreCandidate(
  candidate: Awaited<ReturnType<typeof fetchCardsightUuidNativeCandidates>>[number],
  identity: CardIdentityHint,
): number | null {
  const wantPlayer = String(identity.playerName ?? "").trim().toLowerCase();
  const gotPlayer = String(candidate.player ?? "").trim().toLowerCase();
  if (wantPlayer.length === 0 || gotPlayer.length === 0) return null;
  const playerMatch = gotPlayer === wantPlayer || gotPlayer.includes(wantPlayer) || wantPlayer.includes(gotPlayer);
  if (!playerMatch) return null;

  const wantYear = typeof identity.cardYear === "number"
    ? identity.cardYear
    : identity.cardYear != null ? parseInt(String(identity.cardYear), 10) : null;
  const gotYear = candidate.year;
  if (wantYear != null && gotYear != null && wantYear !== gotYear) return null;

  let score = 5;  // baseline for player + year OK
  if (identity.parallel && candidate.parallel) {
    const wp = identity.parallel.trim().toLowerCase();
    const gp = candidate.parallel.trim().toLowerCase();
    if (wp === gp) score += 5;
    else if (gp.includes(wp) || wp.includes(gp)) score += 2;
  }
  if (identity.number && candidate.cardNumber) {
    if (identity.number.trim().toLowerCase() === candidate.cardNumber.trim().toLowerCase()) score += 3;
  }
  if (identity.product && candidate.setName) {
    const wp = identity.product.trim().toLowerCase();
    const gp = candidate.setName.trim().toLowerCase();
    if (gp.includes(wp) || wp.includes(gp)) score += 2;
  }
  return score;
}

/**
 * Select graded records matching the requested grade string (e.g. "PSA 10",
 * "BGS 9.5"). Returns an empty array on no match — caller falls back to
 * raw records or empty.
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
 * Cardsight fallback for findCompsRouted. Called ONLY when CardHedge
 * returns null (no bridge / no match). Returns a RoutedResult with
 * source="cardsight" sales, or null on any failure — caller returns
 * empty in the null case.
 *
 * Latency budget: ~200-500ms end-to-end (CS search ~200ms + top-5 details
 * ~150ms each in parallel + pricing ~200ms). Only fires on CH-miss so the
 * happy CH path is unaffected.
 */
export async function tryCardsightFallback(
  query: string,
  identity: CardIdentityHint,
  grade: string,
): Promise<RoutedResult | null> {
  if (!isCardsightConfigured()) return null;
  if (!query || !query.trim()) return null;

  const start = Date.now();
  let candidates: Awaited<ReturnType<typeof fetchCardsightUuidNativeCandidates>>;
  try {
    candidates = await fetchCardsightUuidNativeCandidates(query);
  } catch (err) {
    log("cs_fallback.search_error", {
      query,
      error: (err as Error)?.message ?? String(err),
    });
    return null;
  }
  if (candidates.length === 0) {
    log("cs_fallback.no_candidates", { query, latency_ms: Date.now() - start });
    return null;
  }

  // Score + rank
  let best: { candidate: (typeof candidates)[number]; score: number } | null = null;
  for (const c of candidates) {
    const s = scoreCandidate(c, identity);
    if (s == null) continue;
    if (!best || s > best.score) best = { candidate: c, score: s };
  }
  if (!best) {
    log("cs_fallback.no_matching_candidate", {
      query,
      candidateCount: candidates.length,
      wantPlayer: identity.playerName,
    });
    return null;
  }

  const parsed = parseCsCandidateId(best.candidate.candidateId);
  if (!parsed) {
    log("cs_fallback.malformed_candidate_id", {
      candidateId: best.candidate.candidateId,
    });
    return null;
  }

  let pricing: CardsightPricingResponse;
  try {
    pricing = await getPricing(parsed.parentId, { parallelId: parsed.parallelId });
  } catch (err) {
    log("cs_fallback.pricing_error", {
      parentId: parsed.parentId,
      parallelId: parsed.parallelId,
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
      // Preserve CS-native wire-shape fields so the routed-search RawComp
      // mapper in compiqEstimate.service.ts (line ~2588) can read them via
      // its defensive cast to `{listing_type?, image_url?}`. TS structural
      // typing on RoutedSale allows the extra properties without a widening.
      listing_type: r.listing_type ?? null,
      image_url: r.image_url ?? null,
    }) as RoutedSale);

  if (sales.length === 0) {
    log("cs_fallback.no_sales_after_filter", {
      parentId: parsed.parentId,
      parallelId: parsed.parallelId,
      grade,
      rawCount: pricing.raw?.count ?? 0,
      latency_ms: Date.now() - start,
    });
    return null;
  }

  const card: RoutedCard = {
    card_id: `cardsight:${parsed.parentId}::${parsed.parallelId}`,
    player: best.candidate.player ?? identity.playerName,
    set: best.candidate.setName ?? identity.product,
    year: best.candidate.year ?? identity.cardYear,
    number: best.candidate.cardNumber ?? identity.number,
    variant: best.candidate.parallel ?? identity.parallel,
    title: best.candidate.title,
    // CardIdentity.imageUrl is string|null; RoutedCard.imageUrl is
    // string|undefined. Coerce null → undefined so tsc strict passes.
    imageUrl: best.candidate.imageUrl ?? undefined,
  };

  log("cs_fallback.served", {
    query,
    parentId: parsed.parentId,
    parallelId: parsed.parallelId,
    parallelName: best.candidate.parallel,
    salesCount: sales.length,
    score: best.score,
    latency_ms: Date.now() - start,
  });

  return {
    card,
    sales,
    variantWarning: [],
    aiCategory: null,
  };
}

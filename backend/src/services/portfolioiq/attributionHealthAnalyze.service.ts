// CF-ATTRIBUTION-HEALTH (Drew, 2026-07-17). Portfolio-level attribution
// health surface — reads the Phase 1 pHash cluster stats
// (ch_card_attribution_stats) for each of a user's holdings that
// carries a cardId, and returns the holdings where the community
// disagrees on identity: card_ids with multiple visual clusters where
// some sales look like a DIFFERENT physical card.
//
// The pHash pipeline (backend/src/services/attribution/*) hashes every
// sale image and clusters per card_id. When a card_id ends up with
// cluster_count >= 2 AND a smaller cluster than the largest, the
// pipeline flags it `suspect: true`. This service reads that flag
// across the user's holdings and returns a per-holding summary iOS
// can render as a "Verify identity" nudge.
//
// otherCandidates is provisioned in the response shape but populated
// only when Phase 2 (cross-card cluster matching) is available — for
// now it's always an empty array. The confidence + reason field alone
// is enough for the "verify this SKU" UX on the card-detail screen.
//
// Reads Cosmos (once for the user doc, once per suspect card_id) —
// never throws. Missing stats container / missing per-card row
// silently degrades to "no signal", not an error.

import { readUserDoc } from "./portfolioStore.service.js";
import { readAttributionStats } from "../attribution/phashStore.service.js";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import type { CHCardAttributionStats } from "../../types/chSalePhash.types.js";

/**
 * attributionScore ≥ this → confidence "verified". Below → "low_confidence"
 * and the holding surfaces as a suspect. Chosen so ~15% mis-classified
 * sales (largest cluster ≥ 85%) still passes as verified — visual noise
 * from crop variation shouldn't spam this surface.
 */
export const VERIFIED_SCORE_THRESHOLD = 0.85;

/**
 * Minimum total hashed sales before the score is trustworthy. Below
 * this we return an "insufficient" confidence tier and don't surface
 * the holding at all (2-3 sales isn't enough to distinguish a real
 * mis-attribution from a lone crop outlier).
 */
export const MIN_TOTAL_SALES_FOR_SIGNAL = 6;

export interface AttributionSuspectOtherCandidate {
  cardId: string;
  confidence: "low_confidence" | "verified";
}

export interface AttributionHealthSuspect {
  holdingId: string;
  player: string;
  cardTitle: string;
  cardId: string;
  attributionScore: number;
  confidence: "low_confidence" | "verified";
  reason: string;
  otherCandidates: AttributionSuspectOtherCandidate[];
}

export interface AttributionHealthResult {
  scannedHoldings: number;
  suspectCount: number;
  suspects: AttributionHealthSuspect[];
}

/**
 * Analyze the user's portfolio for mis-attribution suspects.
 *
 * Reads the user doc, walks each holding with a non-empty cardId, and
 * looks up the current attribution stats for that cardId. Holdings
 * without a cardId are skipped entirely (nothing to look up).
 *
 * De-dupes multiple holdings sharing a cardId — the response returns
 * one suspect entry per holdingId (the pHash signal is per card_id but
 * the surface is per-holding so iOS can deep-link).
 */
export async function analyzeAttributionHealth(
  userId: string,
): Promise<AttributionHealthResult> {
  const doc = await readUserDoc(userId).catch(() => ({ holdings: {} } as { holdings: Record<string, PortfolioHolding> }));
  const holdings = Object.values(doc.holdings ?? {}) as PortfolioHolding[];

  // Filter to holdings with a cardId — nothing else has a lookup key.
  const withCardId = holdings.filter(
    (h) => typeof (h as { cardId?: string | null }).cardId === "string" &&
           ((h as { cardId?: string | null }).cardId as string).trim() !== "",
  );

  const scannedHoldings = withCardId.length;
  if (scannedHoldings === 0) {
    return { scannedHoldings: 0, suspectCount: 0, suspects: [] };
  }

  // Read stats for each unique cardId — parallel, best-effort.
  const uniqueCardIds = Array.from(new Set(
    withCardId.map((h) => String((h as { cardId?: string }).cardId).trim()),
  ));
  const statsByCardId = new Map<string, CHCardAttributionStats | null>();
  await Promise.all(uniqueCardIds.map(async (cardId) => {
    const stats = await readAttributionStats(cardId).catch(() => null);
    statsByCardId.set(cardId, stats);
  }));

  const suspects: AttributionHealthSuspect[] = [];
  for (const holding of withCardId) {
    const cardId = String((holding as { cardId?: string }).cardId).trim();
    const stats = statsByCardId.get(cardId);
    const suspect = buildSuspect(holding, cardId, stats);
    if (suspect) suspects.push(suspect);
  }

  // Sort by ascending attributionScore — worst signal first. iOS lists
  // the most-suspect holdings at the top of the "Verify" screen.
  suspects.sort((a, b) => a.attributionScore - b.attributionScore);

  return {
    scannedHoldings,
    suspectCount: suspects.length,
    suspects,
  };
}

/**
 * Pure decision logic for turning attribution stats into a suspect
 * entry. Returns null when the holding is either not-suspect or when
 * signal is too thin to render.
 *
 * Exposed for direct testing without a Cosmos mock (the compute half
 * of an analyze/compute split).
 */
export function buildSuspect(
  holding: PortfolioHolding,
  cardId: string,
  stats: CHCardAttributionStats | null | undefined,
): AttributionHealthSuspect | null {
  if (!stats) return null;
  if (!Number.isFinite(stats.total_hashed_sales) || stats.total_hashed_sales <= 0) {
    return null;
  }
  if (stats.total_hashed_sales < MIN_TOTAL_SALES_FOR_SIGNAL) return null;
  if (!stats.suspect) return null;

  const score = computeAttributionScore(stats);
  if (score >= VERIFIED_SCORE_THRESHOLD) return null;

  const outsideDominant = stats.total_hashed_sales - stats.largest_cluster_size;
  const holdingId = String(holding.id ?? "");
  const player = String(holding.playerName ?? "").trim() || "unknown";
  const cardTitle = String(holding.cardTitle ?? "").trim() || describeHolding(holding);

  return {
    holdingId,
    player,
    cardTitle,
    cardId,
    attributionScore: round(score, 3),
    confidence: "low_confidence",
    reason: buildReason(outsideDominant),
    otherCandidates: [],
  };
}

/**
 * Score = fraction of hashed sales that land in the LARGEST visual
 * cluster. 1.0 → every sale looks the same (clean); 0.5 → 50/50 split
 * between two visually distinct cards (very suspect).
 */
export function computeAttributionScore(stats: CHCardAttributionStats): number {
  const total = stats.total_hashed_sales;
  if (!(total > 0)) return 1;
  const largest = stats.largest_cluster_size;
  return largest / total;
}

function buildReason(outsideDominantCount: number): string {
  const salesWord = outsideDominantCount === 1 ? "sale" : "sales";
  return `${outsideDominantCount} ${salesWord} hash-cluster to a different card_id — SKU may be misattributed`;
}

function describeHolding(h: PortfolioHolding): string {
  const parts = [
    h.cardYear ? String(h.cardYear) : "",
    h.setName ?? "",
    h.playerName ?? "",
    h.cardNumber ?? "",
    h.parallel ?? "",
  ].filter((s) => s && s.trim() !== "");
  return parts.join(" ").trim() || "untitled holding";
}

function round(x: number, digits: number): number {
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

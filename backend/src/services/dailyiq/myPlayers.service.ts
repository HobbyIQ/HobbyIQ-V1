/**
 * CF-DAILYIQ-MY-PLAYERS (2026-07-01):
 * Assemble a per-user view of matched-cohort trends for players the
 * user OWNS + watches. Distinct from `/market/players` which is a
 * hobby-wide discovery surface — this endpoint is personal.
 *
 * Response structure: one row per unique player the user owns, each
 * row carries:
 *   - player-level momentum snapshot (matched-cohort medianRatio,
 *     supplyTrend classification, volumeRatio, 30d total sales)
 *   - the specific cards the user owns that appear in the cohort
 *     (with per-card ratio) — so the user sees "your CPA-EHA base
 *     auto is up 38%" alongside the aggregate "Hartman is up 36%"
 *
 * Read-only. All data comes from caches populated by other paths
 * (matched-cohort job, existing /search request-time snapshots).
 * No new writes.
 */

import { readUserDoc } from "../portfolioiq/portfolioStore.service.js";
import { readMatchedCohortFromCache } from "../playerTrend/matchedCohortCache.js";
import { getPlayerTrendSnapshot } from "../playerTrend/index.js";
import type {
  MatchedCohortMember,
  MatchedCohortResult,
} from "../playerTrend/matchedCohort.types.js";
import type {
  PlayerMatchedCohortSummary,
  SupplyTrendClassification,
} from "../playerTrend/playerTrend.types.js";

/** Per-owned-card cohort attribution — surfaces the user's holdings that
 *  appear in the cohort with their per-card ratio. */
export interface MyPlayerOwnedCard {
  cardId: string;
  ratio: number;
  latestWeekMedianPrice: number;
  priorWindowMedianPrice: number;
  latestWeekSaleCount: number;
  priorWindowSaleCount: number;
  /** How many copies of this card the user owns (dedup within their portfolio). */
  quantity: number;
}

export interface MyPlayerRow {
  player: string;
  /** How many holdings the user has for this player (any card, any grade). */
  holdingCount: number;
  /**
   * User's owned cards that appear in the matched-cohort's per-card list.
   * Empty when: cohort cache empty for this player, OR none of the user's
   * cards showed up in both cohort windows (typically low-turnover cards
   * held by the user).
   */
  ownedCardsInCohort: MyPlayerOwnedCard[];
  /** Aggregate matched-cohort summary. Null when the cohort cache misses. */
  matchedCohort: PlayerMatchedCohortSummary | null;
  /** Raw player-level supply-trend classification. Uses matched-cohort as
   *  the price input when available (per PR #236). */
  supplyTrend: SupplyTrendClassification;
  /** Raw sales-stats-by-player momentum ratio (fallback signal). */
  momentumRatio: number | null;
  /** Raw sales-stats-by-player volume ratio. */
  volumeRatio: number | null;
  /** 30d cumulative sales count for this player. */
  totalSales30d: number | null;
  /** Provider name at the time the snapshot was captured. */
  providerName: string;
  /** Timestamp of the snapshot capture. */
  capturedAtMs: number;
}

export interface MyPlayersPayload {
  success: true;
  generatedAt: string;
  myPlayers: MyPlayerRow[];
}

/** Collect per-player holding stats from a user's document. */
export interface UserHoldingSummary {
  player: string;
  holdingCount: number;
  /** cardId → quantity map for cards the user owns for this player. */
  perCardQuantity: Map<string, number>;
}

/**
 * Pure function: enrich a user's holding summary with cohort per-card
 * ratios. Callers hand in the raw ownership map + the matched-cohort
 * result; this returns the intersection.
 *
 * Exported for direct pin testing.
 */
export function enrichOwnedCardsFromCohort(
  perCardQuantity: Map<string, number>,
  cohort: MatchedCohortResult | null,
): MyPlayerOwnedCard[] {
  if (!cohort || cohort.cohort.length === 0) return [];
  if (perCardQuantity.size === 0) return [];

  const cohortByCardId = new Map<string, MatchedCohortMember>();
  for (const m of cohort.cohort) cohortByCardId.set(m.cardId, m);

  const out: MyPlayerOwnedCard[] = [];
  for (const [cardId, quantity] of perCardQuantity.entries()) {
    const member = cohortByCardId.get(cardId);
    if (!member) continue;
    out.push({
      cardId,
      ratio: member.ratio,
      latestWeekMedianPrice: member.latestWeekMedianPrice,
      priorWindowMedianPrice: member.priorWindowMedianPrice,
      latestWeekSaleCount: member.latestWeekSaleCount,
      priorWindowSaleCount: member.priorWindowSaleCount,
      quantity,
    });
  }
  // Highest per-card ratio first — the user's best-trending owned card
  // for this player leads the drill-down.
  out.sort((a, b) => b.ratio - a.ratio);
  return out;
}

/**
 * Extract unique player-name summaries from a user's holdings.
 * Player name is normalized (trimmed + case-preserved on the first
 * encounter). Cards without a playerName field are silently dropped
 * from the summary; they'd need to come through a re-price to gain
 * one anyway.
 *
 * Exported for direct pin testing.
 */
export function summarizeUserHoldingsByPlayer(
  holdings: Record<string, {
    playerName?: string | null;
    cardId?: string | null;
    quantity?: number | null;
  } | null | undefined>,
): UserHoldingSummary[] {
  const byPlayerKey = new Map<string, UserHoldingSummary>();
  for (const h of Object.values(holdings ?? {})) {
    if (!h) continue;
    const name = typeof h.playerName === "string" ? h.playerName.trim() : "";
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    let entry = byPlayerKey.get(key);
    if (!entry) {
      entry = { player: name, holdingCount: 0, perCardQuantity: new Map() };
      byPlayerKey.set(key, entry);
    }
    entry.holdingCount += 1;
    const cardId = typeof h.cardId === "string" ? h.cardId.trim() : "";
    if (cardId.length > 0) {
      const qty = typeof h.quantity === "number" && h.quantity > 0 ? h.quantity : 1;
      entry.perCardQuantity.set(cardId, (entry.perCardQuantity.get(cardId) ?? 0) + qty);
    }
  }
  // Sort by holdingCount DESC — user's most-invested players first.
  return Array.from(byPlayerKey.values()).sort((a, b) => b.holdingCount - a.holdingCount);
}

/**
 * Main entry point: for the given userId, return the MyPlayersPayload.
 * Reads the user doc + per-player caches + snapshots. Never throws;
 * per-player errors are absorbed with a warning and skipped.
 */
export async function assembleMyPlayersForUser(
  userId: string,
): Promise<MyPlayersPayload> {
  const generatedAt = new Date().toISOString();
  const empty: MyPlayersPayload = { success: true, generatedAt, myPlayers: [] };

  if (!userId) return empty;

  let doc: Awaited<ReturnType<typeof readUserDoc>>;
  try {
    doc = await readUserDoc(userId);
  } catch (err) {
    console.warn(
      `[myPlayers] readUserDoc(${userId}) failed: ${(err as Error)?.message ?? err}`,
    );
    return empty;
  }

  const summaries = summarizeUserHoldingsByPlayer(doc.holdings ?? {});
  if (summaries.length === 0) return empty;

  const rows: MyPlayerRow[] = [];
  for (const summary of summaries) {
    try {
      const [cached, snapshot] = await Promise.all([
        readMatchedCohortFromCache(summary.player),
        getPlayerTrendSnapshot(summary.player),
      ]);
      const ownedCardsInCohort = enrichOwnedCardsFromCohort(
        summary.perCardQuantity,
        cached?.result ?? null,
      );
      rows.push({
        player: summary.player,
        holdingCount: summary.holdingCount,
        ownedCardsInCohort,
        matchedCohort: snapshot?.matchedCohort ?? null,
        supplyTrend: snapshot?.supplyTrend ?? "flat",
        momentumRatio: snapshot?.momentum.momentumRatio ?? null,
        volumeRatio: snapshot?.momentum.volumeRatio ?? null,
        totalSales30d: snapshot?.totalSales30d ?? null,
        providerName: snapshot?.providerName ?? "unknown",
        capturedAtMs: snapshot?.capturedAtMs ?? Date.now(),
      });
    } catch (err) {
      console.warn(
        `[myPlayers] player=${summary.player} failed (non-fatal): ${(err as Error)?.message ?? err}`,
      );
    }
  }

  return { success: true, generatedAt, myPlayers: rows };
}

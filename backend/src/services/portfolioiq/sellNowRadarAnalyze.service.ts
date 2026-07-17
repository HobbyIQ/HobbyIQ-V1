// CF-SELL-NOW-RADAR (Drew, 2026-07-17). Orchestration for the sell-now
// radar: iterate a user's holdings, pull SKU velocity + player momentum
// from the local corpus + player_trends, apply the pure-math gate,
// return the sorted candidate list.
//
// SKU baseline construction: we compare velocityPerWeek over the
// RECENT window (default 30d — "is it heating up now?") against
// velocityPerWeek over the BASELINE window (default 90d — "what's the
// normal weekly volume for this SKU?"). The ratio is the multiple.
//
// This service NEVER throws — an individual holding that fails to
// resolve gets skipped, not surfaced as a candidate. The endpoint
// caller sees a stable, sortable list.

import { lookupLocalComps } from "./localCompStore.service.js";
import { readPlayerTrend } from "./playerTrendStore.service.js";
import {
  evaluateSellNowCandidate,
  type SellRadarCardTrend,
  type SellRadarPlayerTrend,
  type SellRadarOptions,
} from "./sellNowRadarCompute.service.js";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import type { LocalCompLookupKey } from "../../types/localComp.types.js";

const DEFAULT_RECENT_WINDOW_DAYS = 30;
const DEFAULT_BASELINE_WINDOW_DAYS = 90;

/** Options for the orchestration layer. */
export interface SellRadarAnalyzeOptions extends SellRadarOptions {
  /** Recent-window width for the velocity numerator. Default 30. */
  recentWindowDays?: number;
  /** Baseline-window width for the velocity denominator. Default 90. */
  baselineWindowDays?: number;
}

/** One row of the candidate list surfaced by the endpoint. */
export interface SellRadarCandidate {
  holdingId: string;
  player: string;
  cardTitle: string;
  graderTier: string;

  currentMarketValue: number | null;
  purchasePrice: number | null;
  unrealizedGainUsd: number | null;

  velocityPerWeek: number;
  velocityBaseline: number;
  velocityMultiple: number;

  playerMomentum: number;
  playerDirection: "up" | "flat" | "down";

  reason: string;
  urgencyScore: number;
}

/** Iterate holdings, apply the sell-now gate, return sorted candidates.
 *  Bounded by user's holding count — a portfolio with 500 holdings will
 *  fire up to 500 SKU lookups + 500 player-trend reads (both cache-hit
 *  cheap in steady-state). */
export async function detectSellNowCandidates(
  holdings: PortfolioHolding[],
  opts: SellRadarAnalyzeOptions = {},
): Promise<SellRadarCandidate[]> {
  const recentWindowDays = opts.recentWindowDays ?? DEFAULT_RECENT_WINDOW_DAYS;
  const baselineWindowDays = opts.baselineWindowDays ?? DEFAULT_BASELINE_WINDOW_DAYS;
  const candidates: SellRadarCandidate[] = [];

  // Small per-player cache — many portfolios stack multiple SKUs of the
  // same player (Judge x5, Ohtani x8). One player_trends read per player
  // regardless of how many holdings reference them.
  const playerTrendCache = new Map<string, SellRadarPlayerTrend | null>();

  for (const holding of holdings) {
    const cardTrend = await deriveSkuTrend(holding, recentWindowDays, baselineWindowDays);
    const playerName = (holding.playerName ?? "").trim();
    if (!playerName) continue;

    let playerTrend: SellRadarPlayerTrend | null | undefined = playerTrendCache.get(playerName);
    if (playerTrend === undefined) {
      playerTrend = await derivePlayerTrend(playerName);
      playerTrendCache.set(playerName, playerTrend);
    }

    const decision = evaluateSellNowCandidate(cardTrend, playerTrend, opts);
    if (!decision.isCandidate) continue;

    // playerTrend / cardTrend are guaranteed non-null here because
    // evaluateSellNowCandidate would have rejected with a
    // rejectedBy=missing_* branch otherwise.
    const currentMarketValue = pickCurrentMarketValue(holding);
    const purchasePrice = typeof holding.purchasePrice === "number" ? holding.purchasePrice : null;
    const unrealizedGainUsd =
      currentMarketValue != null && purchasePrice != null
        ? currentMarketValue - purchasePrice
        : null;

    candidates.push({
      holdingId: holding.id,
      player: playerName,
      cardTitle: buildCardTitle(holding),
      graderTier: deriveGraderTier(holding),
      currentMarketValue,
      purchasePrice,
      unrealizedGainUsd,
      velocityPerWeek: cardTrend!.velocityPerWeek,
      velocityBaseline: cardTrend!.velocityBaseline,
      velocityMultiple: decision.velocityMultiple,
      playerMomentum: playerTrend!.momentum,
      playerDirection: playerTrend!.direction,
      reason: decision.reason,
      urgencyScore: decision.urgencyScore,
    });
  }

  // Sort by (velocityMultiple x playerMomentum) DESC — same shape as
  // urgencyScore before clamp so hot outliers stay sorted correctly
  // even when the score itself is capped.
  candidates.sort((a, b) => {
    const scoreA = a.velocityMultiple * Math.max(a.playerMomentum, 1);
    const scoreB = b.velocityMultiple * Math.max(b.playerMomentum, 1);
    return scoreB - scoreA;
  });

  return candidates;
}

/** Best-effort SKU trend fetch. Runs the local-comp store TWICE — once
 *  over the recent window, once over the baseline window — so we can
 *  compute the multiple without pretending we have per-day granularity
 *  the store doesn't emit. */
async function deriveSkuTrend(
  holding: PortfolioHolding,
  recentWindowDays: number,
  baselineWindowDays: number,
): Promise<SellRadarCardTrend | null> {
  const key = buildLookupKey(holding);
  if (!key) return null;

  try {
    const [recent, baseline] = await Promise.all([
      lookupLocalComps(key, { trendWindowDays: recentWindowDays, skipPremiums: true }),
      lookupLocalComps(key, { trendWindowDays: baselineWindowDays, skipPremiums: true }),
    ]);

    if (!recent.trend) return null;
    if (!baseline.trend) return null;

    return {
      velocityPerWeek: recent.trend.velocityPerWeek,
      velocityBaseline: baseline.trend.velocityPerWeek,
      direction: recent.trend.momentum,
      slopePerDay: recent.trend.slope,
    };
  } catch {
    return null;
  }
}

/** Best-effort player trend fetch. Returns null on any store failure so
 *  the candidate is just skipped. */
async function derivePlayerTrend(player: string): Promise<SellRadarPlayerTrend | null> {
  try {
    const stored = await readPlayerTrend(player);
    if (!stored) return null;
    return {
      momentum: stored.momentum,
      direction: stored.direction,
      flags: stored.flags ?? [],
    };
  } catch {
    return null;
  }
}

function buildLookupKey(holding: PortfolioHolding): LocalCompLookupKey | null {
  // cardId gets us a fast single-partition read.
  const cardId = typeof holding.cardId === "string" ? holding.cardId.trim() : "";
  if (cardId.length > 0) {
    return {
      cardId,
      grade: normalizeGradeForKey(holding),
      grader: normalizeGraderForKey(holding),
    };
  }
  const player = (holding.playerName ?? "").trim();
  const year = typeof holding.cardYear === "number" ? holding.cardYear : undefined;
  const number = (holding.cardNumber ?? "").trim();
  if (!player || !year || !number) return null;
  return {
    player,
    year,
    number,
    grade: normalizeGradeForKey(holding),
    grader: normalizeGraderForKey(holding),
  };
}

function normalizeGradeForKey(holding: PortfolioHolding): string | undefined {
  const val = holding.gradeValue;
  if (typeof val !== "number" || !Number.isFinite(val)) return undefined;
  // ch_daily_sales grade field is a bare string like "10" or "9.5" or "Raw".
  return String(val);
}

function normalizeGraderForKey(holding: PortfolioHolding): string | undefined {
  const g = (holding.gradingCompany ?? holding.gradeCompany ?? "").trim();
  return g.length > 0 ? g : undefined;
}

function deriveGraderTier(holding: PortfolioHolding): string {
  const company = (holding.gradingCompany ?? holding.gradeCompany ?? "").trim();
  const value = holding.gradeValue;
  if (!company || typeof value !== "number") return "Raw";
  return `${company} ${value}`;
}

function buildCardTitle(holding: PortfolioHolding): string {
  const parts: string[] = [];
  if (typeof holding.cardYear === "number") parts.push(String(holding.cardYear));
  if (holding.setName) parts.push(String(holding.setName));
  else if (holding.product) parts.push(String(holding.product));
  if (holding.parallel && holding.parallel !== "Base") parts.push(String(holding.parallel));
  if (holding.cardNumber) parts.push(`#${holding.cardNumber}`);
  return parts.join(" ").trim() || holding.cardTitle || "Card";
}

function pickCurrentMarketValue(holding: PortfolioHolding): number | null {
  if (typeof holding.fairMarketValue === "number") return holding.fairMarketValue;
  return null;
}

// CF-TIMING-FORECAST (Drew, 2026-07-17). Orchestration: given a card
// identity (or holding), pull local-comp-store trend + player-trend +
// velocity + grader tier, feed into the pure math.
//
// Used by the /timing-forecast endpoints. Never throws — bails clean
// with an "insufficient" confidence result on any resolution failure.

import { lookupLocalComps } from "./localCompStore.service.js";
import { readPlayerTrend } from "./playerTrendStore.service.js";
import { computeTimingAwareForecast } from "./timingAwareForecast.service.js";
import type {
  CardTrendInputs,
  PlayerTrendInputs,
  TimingForecastResult,
} from "../../types/timingForecast.types.js";
import type { LocalCompLookupKey } from "../../types/localComp.types.js";

/** Structured card identity — same as CardIdentityHint but pared to
 *  what the timing forecast needs. */
export interface TimingForecastCardIdentity {
  cardId?: string;
  player?: string;
  cardYear?: number | string;
  cardNumber?: string;
  cardSet?: string;
  variant?: string;
  gradeCompany?: string;   // "PSA", "BGS", etc — empty for raw holdings
  gradeValue?: string;     // "10", "9.5", etc
}

export async function analyzeTimingForecast(
  identity: TimingForecastCardIdentity,
  horizonDays = 30,
): Promise<TimingForecastResult> {
  const graderTier = deriveGraderTier(identity);

  // Pull local-comp-store data for the SKU. Prefer cardId (fast
  // single-partition) then structured (player + year + number).
  const lookupKey: LocalCompLookupKey = identity.cardId
    ? { cardId: identity.cardId }
    : {
        player: identity.player,
        year: identity.cardYear !== undefined && identity.cardYear !== null
          ? Number(identity.cardYear)
          : undefined,
        number: identity.cardNumber,
      };

  let cardTrend: CardTrendInputs | null = null;
  let skuVelocityPerWeek = 0;
  try {
    const local = await lookupLocalComps(lookupKey, { skipPremiums: true });
    if (local.totalSales > 0 && local.trend) {
      cardTrend = {
        projectedNextSalePrice: local.trend.projectedNextSalePrice,
        slopePerDay: local.trend.slope,
        volatility: local.trend.volatility,
        windowSales: local.windowSales,
        latestPrice: local.trend.latestPrice,
      };
      skuVelocityPerWeek = local.trend.velocityPerWeek;
    }
  } catch {
    /* best-effort; leave cardTrend null */
  }

  // Player trend — nightly cache is fine, don't fall back to on-demand
  // compute here to keep this endpoint fast. When cache misses the
  // forecast just weights via cardTrend alone.
  //
  // Type note: `raw` and `graded` sub-trends land on StoredPlayerTrend
  // once PR #519 (stratified variants) merges. Until then, the runtime
  // shape from Cosmos may still lack them — we narrow via unknown cast
  // so this compiles clean on pre-#519 main.
  let playerTrend: PlayerTrendInputs | null = null;
  if (identity.player) {
    try {
      const stored = await readPlayerTrend(identity.player);
      if (stored) {
        const strat = stored as unknown as {
          momentum: number;
          velocityPerWeek: number;
          flags?: string[];
          raw?: { momentum: number };
          graded?: { momentum: number };
        };
        playerTrend = {
          allMomentum: strat.momentum,
          rawMomentum: strat.raw?.momentum ?? null,
          gradedMomentum: strat.graded?.momentum ?? null,
          playerVelocityPerWeek: strat.velocityPerWeek,
          playerFlags: strat.flags ?? [],
        };
      }
    } catch {
      /* best-effort; leave playerTrend null */
    }
  }

  return computeTimingAwareForecast({
    cardTrend,
    playerTrend,
    skuVelocityPerWeek,
    currentGraderTier: graderTier,
    horizonDays,
  });
}

function deriveGraderTier(identity: TimingForecastCardIdentity): string {
  const company = (identity.gradeCompany ?? "").trim();
  const value = (identity.gradeValue ?? "").trim();
  if (!company || !value) return "Raw";
  return `${company} ${value}`;
}

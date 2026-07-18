// CF-DAILYIQ-ACTION-PLAN (Drew, 2026-07-17). Orchestration: fetch
// every signal we've built for each holding in a user's portfolio,
// feed into computeActionPlan (pure math), return the sorted feed.
//
// Data hop tally per holding:
//   - matched-cohort weekly rate → player_trends container
//   - cascade fire → cascadeAlerts container / recent-fires cache
//   - sell-radar velocity + momentum → sellNowRadarAnalyze (batched)
//   - grade-worthy → analyzeHoldingGradeWorthy (per-card)
//   - marketValue + predictedPrice → the holding already has these
//     persisted from the last reprice (autoPriceHolding sync)
//
// Perf: sell-radar iterates all holdings in one call; grade-worthy
// and cascade fetches are per-holding, wrapped in Promise.all with a
// bounded concurrency (default 5) so we don't overwhelm Cosmos for
// 200-holding portfolios.

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import type { ActionVerdict, ActionPlanResult } from "./dailyIqActionPlanCompute.service.js";
import { computeActionPlan } from "./dailyIqActionPlanCompute.service.js";

export interface ActionPlanRow {
  holdingId: string;
  cardId: string | null;
  playerName: string;
  cardTitle: string;
  grade: string;
  imageUrl: string | null;

  verdict: ActionVerdict;
  urgency: number;
  reason: string;
  priceTarget: number | null;
  windowClosesIn: string | null;

  marketValue: number | null;
  predictedPrice: number | null;
  purchasePrice: number | null;
  unrealizedGainUsd: number | null;

  isGuestimate: boolean;
}

export interface ActionPlanResponse {
  generatedAt: string;
  totalHoldings: number;
  actions: ActionPlanRow[];
  counts: Record<ActionVerdict, number>;
}

const DEFAULT_CONCURRENCY = 5;

/** Bounded concurrent map. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

function isEbayLike(_h: PortfolioHolding): boolean {
  // Placeholder — currentAskingPrice depends on a listing surface we
  // haven't unified yet. When we wire in listing data, populate this.
  return false;
}

export async function buildActionPlan(
  holdings: PortfolioHolding[],
): Promise<ActionPlanResponse> {
  // 1. Sell-radar batch
  let sellRadarByHoldingId = new Map<string, {
    velocityMultiple: number;
    playerMomentum: number;
    playerDirection: "up" | "flat" | "down";
    cardDirection: "up" | "flat" | "down";
  }>();
  try {
    const { detectSellNowCandidates } = await import("../portfolioiq/sellNowRadarAnalyze.service.js");
    const candidates = await detectSellNowCandidates(holdings);
    for (const c of candidates) {
      sellRadarByHoldingId.set(c.holdingId, {
        velocityMultiple: c.velocityMultiple,
        playerMomentum: c.playerMomentum,
        playerDirection: c.playerDirection,
        // sell-radar filters cardDirection non-down; if it made the list, it's up/flat.
        cardDirection: "up",
      });
    }
  } catch {
    // best-effort — no sell-radar just means no SELL_NOW verdicts
    sellRadarByHoldingId = new Map();
  }

  // 2. Cascade fires by player
  //
  // CF-DAILYIQ-CASCADE-WIRE (Drew, 2026-07-17): read cascade events
  // from the cascade_events store (PR #531 nightly detection) for
  // players in this portfolio. Latest fire per player wins so the
  // action-plan compute gets the freshest daysSinceFire.
  const cascadeByPlayer = new Map<string, { firedAt: string; daysSinceFire: number; audienceTier: "insider" | "beat_writer" | "engaged_fan" | "buyer" }>();
  try {
    const players = [
      ...new Set(holdings.map((h) => (h.playerName ?? "").trim()).filter(Boolean)),
    ];
    if (players.length > 0) {
      const [{ readRecentEventsForPlayers }, { slugPlayer }] = await Promise.all([
        import("../portfolioiq/cascadeEventStore.service.js"),
        import("../portfolioiq/playerTrendStore.service.js"),
      ]);
      const slugToPlayer = new Map<string, string>();
      const slugs = players.map((p) => {
        const s = slugPlayer(p);
        slugToPlayer.set(s, p);
        return s;
      });
      const sinceIso = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const events = await readRecentEventsForPlayers(slugs, sinceIso);
      const now = Date.now();
      for (const ev of events) {
        const player = slugToPlayer.get(ev.playerSlug) ?? ev.player;
        const firedMs = new Date(ev.detectedAt).getTime();
        const daysSinceFire = Math.max(0, Math.round((now - firedMs) / (24 * 3600 * 1000)));
        // Severity → audienceTier mapping (compute doesn't use it in
        // the gate, but iOS renders the label; kept as a stable
        // "how loud is this" hint):
        //   insider → insider, emerging → engaged_fan, confirmed → buyer
        const audienceTier: "insider" | "beat_writer" | "engaged_fan" | "buyer" =
          ev.severity === "insider" ? "insider" :
          ev.severity === "emerging" ? "engaged_fan" :
          "buyer";
        const existing = cascadeByPlayer.get(player);
        if (!existing || daysSinceFire < existing.daysSinceFire) {
          cascadeByPlayer.set(player, { firedAt: ev.detectedAt, daysSinceFire, audienceTier });
        }
      }
    }
  } catch { /* silent — no cascade data is not fatal */ }

  // 3. Per-holding: matched-cohort rate + grade-worthy analysis, bounded concurrency
  const perHoldingSignals = await mapWithConcurrency(holdings, DEFAULT_CONCURRENCY, async (h) => {
    let matchedCohortWeeklyRate: number | null = null;
    let gradeWorthy: ActionPlanRow extends never ? never : {
      bestTier: string;
      expectedNetUplift: number;
      expectedUpliftPct: number;
      confidence: "high" | "medium" | "low";
    } | null = null;

    // matched-cohort rate
    try {
      if (h.playerName && String(h.playerName).trim()) {
        const { readPlayerTrend } = await import("../portfolioiq/playerTrendStore.service.js");
        const trend = await readPlayerTrend(String(h.playerName));
        if (trend && typeof trend.momentum === "number" && Number.isFinite(trend.momentum)) {
          matchedCohortWeeklyRate = trend.momentum - 1;
        }
      }
    } catch { /* silent */ }

    // grade-worthy — only meaningful for raw holdings
    const isRaw = !h.gradingCompany || String(h.gradingCompany).trim().length === 0;
    if (isRaw) {
      try {
        const { analyzeHoldingGradeWorthy } = await import("../portfolioiq/gradeWorthyAnalyze.service.js");
        const gwResult = await analyzeHoldingGradeWorthy(h);
        const bestTier = gwResult.analysis.bestTier;
        const raw = gwResult.analysis.rawPrice;
        // Only fire GRADE_UP for confirmed-worthy tiers (avoids
        // "insufficient_data" and "not_worth" tiers). Confidence is
        // proxied by sample size: n>=20 → high, 8-19 → medium, else low.
        if (
          bestTier
          && raw > 0
          && (bestTier.recommendation === "grade_now"
              || bestTier.recommendation === "grade_worthy_but_wait")
        ) {
          const confidence: "high" | "medium" | "low" =
            bestTier.gradedSampleSize >= 20 ? "high" :
            bestTier.gradedSampleSize >= 8 ? "medium" : "low";
          gradeWorthy = {
            bestTier: bestTier.graderTier,
            expectedNetUplift: bestTier.expectedGain,
            expectedUpliftPct: bestTier.expectedGain / raw,
            confidence,
          };
        }
      } catch { /* silent */ }
    }

    return { matchedCohortWeeklyRate, gradeWorthy };
  });

  // 4. Compose per-holding rows
  const actions: ActionPlanRow[] = holdings.map((h, i) => {
    const signals = perHoldingSignals[i];
    const isGuestimate =
      (h as { predictedPriceMechanism?: string | null }).predictedPriceMechanism === "guestimate"
      || (h.valuationStatus === "estimated" && (h as { estimateBasis?: string | null }).estimateBasis === "guestimate");

    const result: ActionPlanResult = computeActionPlan({
      marketValue: h.fairMarketValue ?? h.estimatedValue ?? null,
      predictedPrice: h.predictedPrice ?? null,
      currentAskingPrice: isEbayLike(h) ? null : null,   // placeholder for future listing wire
      sellRadar: sellRadarByHoldingId.get(h.id) ?? null,
      cascade: cascadeByPlayer.get(String(h.playerName ?? "").trim()) ?? null,
      gradeWorthy: signals.gradeWorthy,
      matchedCohortWeeklyRate: signals.matchedCohortWeeklyRate,
      isGuestimate,
    });

    const mv = h.fairMarketValue ?? h.estimatedValue ?? null;
    const pp = typeof h.purchasePrice === "number" ? h.purchasePrice : null;
    return {
      holdingId: h.id,
      cardId: h.cardId ?? null,
      playerName: h.playerName ?? "",
      cardTitle: composeTitle(h),
      grade: h.gradingCompany && h.gradeValue
        ? `${h.gradingCompany} ${h.gradeValue}`
        : "Raw",
      imageUrl: (h as { imageUrl?: string | null }).imageUrl
        ?? (h as { ebayImageUrl?: string | null }).ebayImageUrl
        ?? null,

      verdict: result.verdict,
      urgency: result.urgency,
      reason: result.reason,
      priceTarget: result.priceTarget,
      windowClosesIn: result.windowClosesIn,

      marketValue: mv,
      predictedPrice: h.predictedPrice ?? null,
      purchasePrice: pp,
      unrealizedGainUsd:
        typeof mv === "number" && typeof pp === "number" ? mv - pp : null,

      isGuestimate,
    };
  });

  // 5. Sort by urgency descending, then by unrealizedGainUsd for stable
  //    ordering within-verdict.
  actions.sort((a, b) => {
    if (b.urgency !== a.urgency) return b.urgency - a.urgency;
    return (b.unrealizedGainUsd ?? 0) - (a.unrealizedGainUsd ?? 0);
  });

  const counts: Record<ActionVerdict, number> = {
    SELL_NOW: 0, GRADE_UP: 0, LIST_HIGHER: 0, WAIT_TO_LIST: 0, HOLD: 0,
  };
  for (const a of actions) counts[a.verdict]++;

  return {
    generatedAt: new Date().toISOString(),
    totalHoldings: holdings.length,
    actions,
    counts,
  };
}

function composeTitle(h: PortfolioHolding): string {
  const parts: string[] = [];
  if (h.cardYear) parts.push(String(h.cardYear));
  if (h.setName) parts.push(String(h.setName));
  if (h.parallel) parts.push(String(h.parallel));
  if (parts.length === 0) return h.playerName ?? "Untitled card";
  return parts.join(" ");
}

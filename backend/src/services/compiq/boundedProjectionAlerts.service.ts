// CF-TRAJECTORY-12WK bounds alerts (Drew, 2026-07-28).
//
// Tiny in-process accumulator for projection-multiplier bound hits.
// Two call sites (observedGradeCurve trendAdjust + siblingCardPriceFallback
// forward-project) call recordBoundedProjectionAlert whenever their
// linear trajectory math hits the floor or ceiling. drainAlerts() is
// called by the digest job / manual trigger to send Drew ONE email
// summarizing every hit since the last drain.
//
// Why in-process: bounds hits should be rare (extreme rates × long
// lookback). If they're common, that IS the signal — the linear model
// is breaking down and we need a real fix. In-memory is a starting
// point; migrate to a Cosmos-backed queue if we ever need multi-node
// aggregation.

export interface BoundedProjectionAlert {
  source: string;
  playerName: string | null;
  cardId?: string | null;
  rate: number;
  weeksSinceSale: number;
  rawMultiplier: number;
  bounded: number;
  direction: "capped-ceiling" | "capped-floor";
  observedAt: string;
}

const _alerts: BoundedProjectionAlert[] = [];

export function recordBoundedProjectionAlert(input: Omit<BoundedProjectionAlert, "observedAt">): void {
  const alert: BoundedProjectionAlert = {
    ...input,
    observedAt: new Date().toISOString(),
  };
  _alerts.push(alert);
  // Also log as a discrete event so App Insights KQL can drill in.
  console.warn(JSON.stringify({
    event: "bounded_projection_alert",
    source: input.source,
    playerName: input.playerName,
    cardId: input.cardId ?? null,
    rate: input.rate,
    weeksSinceSale: input.weeksSinceSale,
    rawMultiplier: Math.round(input.rawMultiplier * 1000) / 1000,
    bounded: Math.round(input.bounded * 1000) / 1000,
    direction: input.direction,
  }));
}

/**
 * Snapshot + reset. Returns everything recorded since the last call and
 * clears the accumulator so subsequent runs get fresh state.
 */
export function drainAlerts(): BoundedProjectionAlert[] {
  const out = _alerts.slice();
  _alerts.length = 0;
  return out;
}

/**
 * Read-only peek — used by tests / callers that want to inspect without
 * emptying the accumulator.
 */
export function peekAlerts(): ReadonlyArray<BoundedProjectionAlert> {
  return _alerts;
}

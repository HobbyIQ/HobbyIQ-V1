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

// CF-COST-BASIS-DIVERGENCE-ALERT (Drew, 2026-07-28). Separate accumulator
// for holdings where the persisted FMV / estimatedValue diverges heavily
// from the user's cost basis. Real repro (Hartman Gold Refractor Auto
// PSA 9): cost $2,325, engine emitted $339 (85% loss) — traced to a
// dilutive sibling-parallel rung that walked past 2 exact-identity raw
// sales at $1,475/$2,500. High divergence is either the pricing being
// wrong (like this case) or a real market move Drew wants surfaced.
// Either way, ONE digest email per reprice cycle is the right UX.

export interface CostBasisDivergenceAlert {
  userId: string;
  holdingId: string;
  cardTitle: string | null;
  playerName: string | null;
  slug: string | null;
  costBasis: number;
  fmv: number;
  gainLossPct: number;  // (fmv - cost) / cost, e.g. -0.854 for the Hartman case
  fmvMethod: string | null;
  fmvBasisNote: string | null;
  fmvCompCount: number | null;
  observedAt: string;
}

const _divergenceAlerts: CostBasisDivergenceAlert[] = [];

/**
 * Threshold: |gain/loss| > 40% AND absolute delta > $500. Small holdings
 * naturally see high % swings; the $500 floor keeps the digest focused on
 * dollar-material cases. Configurable via env for future tuning without
 * a redeploy.
 */
function divergencePctThreshold(): number {
  const v = Number(process.env.PORTFOLIO_DIVERGENCE_PCT ?? "0.40");
  return Number.isFinite(v) && v > 0 ? v : 0.40;
}
function divergenceDollarFloor(): number {
  const v = Number(process.env.PORTFOLIO_DIVERGENCE_DOLLAR_FLOOR ?? "500");
  return Number.isFinite(v) && v > 0 ? v : 500;
}

/**
 * Record a cost-basis vs FMV divergence when the deltas cross both the
 * percentage and dollar thresholds. Callers pass the raw holding facts;
 * this function decides whether to accumulate. Never throws.
 */
export function recordCostBasisDivergenceIfNoteworthy(input: Omit<CostBasisDivergenceAlert, "observedAt" | "gainLossPct">): boolean {
  const { costBasis, fmv } = input;
  if (!Number.isFinite(costBasis) || costBasis <= 0) return false;
  if (!Number.isFinite(fmv) || fmv <= 0) return false;
  const gainLossPct = (fmv - costBasis) / costBasis;
  const absPct = Math.abs(gainLossPct);
  const absDollar = Math.abs(fmv - costBasis);
  if (absPct < divergencePctThreshold()) return false;
  if (absDollar < divergenceDollarFloor()) return false;

  // CF-DIGEST-IS-FOR-MARKET-MOVES (Drew, 2026-08-28). This digest was added
  // for the Hartman case — an engine that priced $339 past $1,475/$2,500
  // exact-identity sales — and it "fixed" that bug by EMAILING DREW about it
  // every reprice cycle. A divergence is only a market signal when the price
  // itself came from the exact-identity pool (unified engine, or a tier the
  // exact-pool supremacy post-pass settled). A divergence produced by a
  // fallback rung is an engine bug report: telemetry, ops KQL, never a
  // user-facing digest.
  const method = String(input.fmvMethod ?? "");
  const basis = String(input.fmvBasisNote ?? "");
  const fromExactPool =
    method === "unified-market-value" || basis.includes("exact-pool supremacy");
  if (!fromExactPool) {
    console.warn(JSON.stringify({
      event: "engine_divergence_suspect",
      note: "fallback-rung price diverged from cost basis; engine quality signal, digest suppressed",
      userId: input.userId,
      holdingId: input.holdingId,
      cardTitle: input.cardTitle,
      slug: input.slug,
      costBasis: Math.round(costBasis * 100) / 100,
      fmv: Math.round(fmv * 100) / 100,
      gainLossPct: Math.round(gainLossPct * 1000) / 1000,
      fmvMethod: input.fmvMethod,
      fmvBasisNote: input.fmvBasisNote,
      fmvCompCount: input.fmvCompCount,
    }));
    return false;
  }
  const alert: CostBasisDivergenceAlert = {
    ...input,
    gainLossPct,
    observedAt: new Date().toISOString(),
  };
  _divergenceAlerts.push(alert);
  console.warn(JSON.stringify({
    event: "cost_basis_fmv_divergence",
    userId: input.userId,
    holdingId: input.holdingId,
    cardTitle: input.cardTitle,
    slug: input.slug,
    costBasis: Math.round(costBasis * 100) / 100,
    fmv: Math.round(fmv * 100) / 100,
    gainLossPct: Math.round(gainLossPct * 1000) / 1000,
    fmvMethod: input.fmvMethod,
    fmvCompCount: input.fmvCompCount,
    direction: gainLossPct < 0 ? "loss" : "gain",
  }));
  return true;
}

export function drainDivergenceAlerts(): CostBasisDivergenceAlert[] {
  const out = _divergenceAlerts.slice();
  _divergenceAlerts.length = 0;
  return out;
}

export function peekDivergenceAlerts(): ReadonlyArray<CostBasisDivergenceAlert> {
  return _divergenceAlerts;
}

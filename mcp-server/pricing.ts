// CompIQ MCP — predictive pricing module.
//
// Fetches the aggregated signal payload from Azure before every OpenAI call,
// builds a forward-looking pricing prompt, and returns a strictly-typed
// PriceResult JSON object. Never call OpenAI for pricing without injecting
// signal context — the module enforces this even when the signal endpoint
// is unreachable (it falls back to a neutral 1.0x multiplier).

import OpenAI, { AzureOpenAI } from "openai";
import { combinedCardModifiers } from "./cardModifiers.js";
import {
  computeCompsAnalytics,
  renderAnalyticsBlock,
  analyticsRiskFlags,
  type CompsAnalytics,
} from "./compsAnalytics.js";
import { lookupCatalyst, type CatalystResult } from "./catalystCalendar.js";
import { trackHttpDependency } from "./telemetry.js";

const SIGNAL_URL = process.env.AZURE_SIGNAL_FUNCTION_URL ?? "";
const SIGNAL_KEY = process.env.AZURE_SIGNAL_FUNCTION_KEY ?? "";
const FLOOR_URL = process.env.AZURE_PRICE_FLOOR_URL ?? "";
const FLOOR_KEY = process.env.AZURE_PRICE_FLOOR_KEY ?? "";

// CF-MCP-PLAYER-IN-SET-BRIDGE (2026-06-10): backend bridge for
// per-(player, release, year) momentum. Replaces the player-wide
// compsMomentum value from fn-serve-signals during /predict so the
// signal reflects the actual card's release direction, not the
// blurred player-wide pool.
//
// SHADOW PHASE: bridge value is FETCHED + LOGGED but does NOT yet
// replace signals.components.compsMomentum or signals.final_multiplier.
// Cutover gated on review of shadow deltas (see /predict shadow log).
const HOBBYIQ_BACKEND_URL = process.env.HOBBYIQ_BACKEND_URL ?? "";
// Aggregator's compsMomentum weight — load-bearing constant for the
// shadow's approximate final_multiplier_new computation. Mirrors
// compiq-functions/fn-signal-aggregator/function.py:42 WEIGHTS map.
const COMPS_MOMENTUM_WEIGHT = 0.20;

// Prefer Azure OpenAI when configured (production HobbyIQ uses Azure OpenAI),
// fall back to the public OpenAI API otherwise.
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT ?? "";
const AZURE_OPENAI_API_KEY =
  process.env.AZURE_OPENAI_API_KEY ?? process.env.AZURE_OPENAI_KEY ?? "";
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT ?? "";
const AZURE_OPENAI_API_VERSION =
  process.env.AZURE_OPENAI_API_VERSION ?? "2024-08-01-preview";

const useAzureOpenAI = Boolean(
  AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_API_KEY && AZURE_OPENAI_DEPLOYMENT
);

const OPENAI_MODEL = useAzureOpenAI
  ? AZURE_OPENAI_DEPLOYMENT
  : process.env.COMPIQ_OPENAI_MODEL ?? "gpt-4o";

// CF-BACKTEST-DETERMINISTIC: lock temperature + seed to stabilize backtest
// runs. Prior multi-run backtests with default temperature produced
// unstable_high_variance verdicts (sign-stability 0.4-0.6 across 5 repeats).
// Temperature=0 + a fixed seed is OpenAI's "best effort" determinism contract.
// Model version is pinned at deployment time on Azure OpenAI (the deployment
// name in AZURE_OPENAI_DEPLOYMENT resolves to a specific snapshot); the
// non-Azure fallback path uses COMPIQ_OPENAI_MODEL env var to pin if desired.
export const OPENAI_DETERMINISTIC_CONFIG = {
  temperature: 0,
  seed: 42,
} as const;

const openai: OpenAI = useAzureOpenAI
  ? new AzureOpenAI({
      endpoint: AZURE_OPENAI_ENDPOINT,
      apiKey: AZURE_OPENAI_API_KEY,
      apiVersion: AZURE_OPENAI_API_VERSION,
      deployment: AZURE_OPENAI_DEPLOYMENT,
    })
  : new OpenAI();

// -------------------------------------------------------------------------
// Card input shape
// -------------------------------------------------------------------------

export interface CardComp {
  price: number;
  date: string;       // ISO 8601
  grade: string;      // "PSA 10", "raw", etc.
  source?: string;    // optional comp source ("eBay", "Goldin", ...)
  title?: string;     // raw listing title (e.g. "2011 Topps Update Mike Trout US175 RC")
}

export interface Card {
  id: string;
  playerName: string;
  year: number;
  set: string;
  cardNumber: string;
  grade?: string;     // "PSA 10", "BGS 9.5", "raw"
  variant?: string;   // "base", "refractor", "parallel", "1st edition"
  printRun?: number;  // e.g. 25 means /25
  isRookie?: boolean;
  jerseyNumber?: number; // M7 — for icon-number premium (Mantle 7, MJ 23, Trout 27)
  anchorPrice: number;
  recentComps: CardComp[];
}

// -------------------------------------------------------------------------
// Signal payload (what the Azure Function returns)
// -------------------------------------------------------------------------

export interface SignalPayload {
  player?: string;
  final_multiplier: number;
  predicted_direction?: "rising" | "falling" | "stable";
  signal_flags?: string[];
  components?: {
    // CF-CARDHEDGE-SIGNAL-RENAME (2026-05-25): compsMomentum replaces the
    // prior un-typed `cardhedge` key from the aggregator. Kept in
    // port-with-provenance sync with backend/src/services/signals/signals.types.ts.
    compsMomentum?: number;
    ebay?: number;
    reddit?: number;
    trends?: number;
    odds?: number;
    stats?: number;
    news?: number;
    youtube?: number;
  };
  component_signals?: Record<string, string>;
  // H5
  bin_signal?: string | null;
  bin_drop_pct?: number | null;
  // H7
  sell_through_rate?: number | null;
  str_signal?: string | null;
  // H8
  show_phase?: string | null;
  show_name?: string | null;
  days_to_show?: number | null;
  show_multiplier?: number | null;
  // M6 pack release calendar
  release_phase?: string | null;
  release_name?: string | null;
  days_to_release?: number | null;
  release_multiplier?: number | null;
  // M9 playoff
  playoff_signal?: string | null;
  playoff_window?: string | null;
  playoff_multiplier?: number | null;
  // M4/M5 career arc
  career_arc_signal?: string[] | null;
  career_arc_multiplier?: number | null;
  updated_at?: string;
}

export const NEUTRAL_SIGNAL: SignalPayload = {
  final_multiplier: 1.0,
  predicted_direction: "stable",
  signal_flags: ["signal_unavailable"],
  components: {},
};

// -------------------------------------------------------------------------
// Strict prediction output schema (must match copilot-instructions.md)
// -------------------------------------------------------------------------

export interface PriceResult {
  predicted_price_72h: number;
  predicted_price_7d: number;
  predicted_direction: "rising" | "falling" | "stable" | "volatile";
  confidence: number;                 // 0-100
  confidence_reason: string;
  key_drivers: string[];              // >= 2 entries enforced below
  risk_flags: string[];
  best_time_to_sell: "now" | "3 days" | "7 days" | "hold";
  catalyst_detected: boolean;
  catalyst_detail: string | null;
  // H6 — populated by post-processing, not by the model
  floor_applied?: boolean;
  floor_value?: number | null;
  // H10 — comp-gating ceiling actually applied
  max_confidence?: number;
  // Phase A — time-series analytics injected for transparency / audit
  analytics?: CompsAnalytics;
}

// -------------------------------------------------------------------------
// H10 — Comp volume gating (per-card, computed locally from card.recentComps)
// -------------------------------------------------------------------------

interface CompGating {
  comp_count_30d: number;
  price_variance_pct: number;
  market_depth: "liquid" | "moderate" | "thin" | "very_thin";
  max_confidence: number;
  comp_flags: string[];
}

function evaluateCompGating(card: Card): CompGating {
  const now = Date.now();
  const dayMs = 86_400_000;
  const last30 = card.recentComps.filter(
    (c) => now - new Date(c.date).getTime() <= 30 * dayMs
  );
  const prices = last30.map((c) => c.price).filter((p) => Number.isFinite(p));
  const compCount = last30.length;

  let variancePct = 100;
  if (prices.length >= 3) {
    const avg = average(prices);
    if (avg > 0) {
      variancePct = ((Math.max(...prices) - Math.min(...prices)) / avg) * 100;
    }
  }

  let depth: CompGating["market_depth"];
  let maxConfidence: number;
  if (compCount >= 20) {
    depth = "liquid";
    maxConfidence = 95;
  } else if (compCount >= 10) {
    depth = "moderate";
    maxConfidence = 80;
  } else if (compCount >= 3) {
    depth = "thin";
    maxConfidence = 65;
  } else {
    depth = "very_thin";
    maxConfidence = 45;
  }

  if (variancePct > 40) {
    maxConfidence = Math.min(maxConfidence, 55);
  }

  const compFlags: string[] = [];
  if (compCount < 5) compFlags.push(`thin_market: only ${compCount} comps in 30 days`);
  if (variancePct > 40) {
    compFlags.push(`high_price_variance: ${round1(variancePct)}% spread`);
  }
  if (compCount === 0) compFlags.push("no_comps: price is speculative only");

  return {
    comp_count_30d: compCount,
    price_variance_pct: round1(variancePct),
    market_depth: depth,
    max_confidence: maxConfidence,
    comp_flags: compFlags,
  };
}

// -------------------------------------------------------------------------
// Signal fetch
// -------------------------------------------------------------------------

export async function fetchSignals(
  playerName: string
): Promise<SignalPayload> {
  if (!SIGNAL_URL) return { ...NEUTRAL_SIGNAL };

  const url = new URL(SIGNAL_URL);
  url.searchParams.set("player", playerName);
  if (SIGNAL_KEY) url.searchParams.set("code", SIGNAL_KEY);
  const fullUrl = url.toString();
  const start = Date.now();

  // CF-FETCH-SIGNAL-FLOOR-TELEMETRY: manual trackDependency around the fetch
  // so failures surface in App Insights `dependencies` table (Node 18+ fetch()
  // is NOT auto-instrumented). Graceful fallback to NEUTRAL_SIGNAL preserved.
  try {
    const resp = await fetch(fullUrl, {
      // 5s budget — pricing is interactive, can't block on a slow blob fetch
      signal: AbortSignal.timeout(5_000),
    });
    trackHttpDependency({
      name: "signal_service",
      url: fullUrl,
      startMs: start,
      resultCode: resp.status,
      success: resp.ok,
    });
    if (!resp.ok) return { ...NEUTRAL_SIGNAL };

    const data = (await resp.json()) as Partial<SignalPayload>;
    const mult = clamp(Number(data.final_multiplier ?? 1.0), 0.7, 1.5);
    return {
      ...NEUTRAL_SIGNAL,
      ...data,
      final_multiplier: mult,
      signal_flags: data.signal_flags ?? [],
      components: data.components ?? {},
    };
  } catch (err) {
    trackHttpDependency({
      name: "signal_service",
      url: fullUrl,
      startMs: start,
      resultCode: 0,
      success: false,
      error: err as Error,
    });
    return { ...NEUTRAL_SIGNAL };
  }
}

// -------------------------------------------------------------------------
// CF-MCP-PLAYER-IN-SET-BRIDGE — per-(player, release, year) momentum
// -------------------------------------------------------------------------

export interface PlayerInSetMomentumBridgeResult {
  multiplier: number | null;
  signal: "rising" | "falling" | "stable" | null;
  source: "playerInSet" | "bridge_unavailable" | "bridge_error" | "bridge_no_data";
}

const BRIDGE_NEUTRAL: PlayerInSetMomentumBridgeResult = {
  multiplier: null,
  signal: null,
  source: "bridge_unavailable",
};

/** Call backend /api/compiq/player-in-set-momentum. Best-effort; null-safe
 *  fallback on any failure. NOT a hard dependency — when the bridge can't
 *  produce a signal (no qualifying cards, network error, backend down),
 *  callers fall through to the player-wide aggregator value. */
export async function fetchPlayerInSetMomentumBridge(
  player: string,
  release: string,
  year: number,
): Promise<PlayerInSetMomentumBridgeResult> {
  if (!HOBBYIQ_BACKEND_URL) return BRIDGE_NEUTRAL;
  if (!player || !release || !Number.isFinite(year) || year <= 0) {
    return { ...BRIDGE_NEUTRAL, source: "bridge_unavailable" };
  }
  const url = new URL(
    "/api/compiq/player-in-set-momentum",
    HOBBYIQ_BACKEND_URL,
  );
  url.searchParams.set("player", player);
  url.searchParams.set("release", release);
  url.searchParams.set("year", String(year));
  const fullUrl = url.toString();
  const start = Date.now();
  try {
    const resp = await fetch(fullUrl, {
      // Stay inside /predict's overall budget. /predict already runs
      // OpenAI + comp fetch + signal fetch concurrently; this is a
      // 3s budget — same as backend's tighter signal fetch.
      signal: AbortSignal.timeout(3_000),
    });
    trackHttpDependency({
      name: "playerInSetMomentum_bridge",
      url: fullUrl,
      startMs: start,
      resultCode: resp.status,
      success: resp.ok,
    });
    if (!resp.ok) return { ...BRIDGE_NEUTRAL, source: "bridge_error" };
    const data = (await resp.json()) as {
      multiplier: number | null;
      signal: "rising" | "falling" | "stable" | null;
    };
    if (data.multiplier === null || data.multiplier === undefined) {
      return { ...BRIDGE_NEUTRAL, source: "bridge_no_data" };
    }
    return {
      multiplier: Number(data.multiplier),
      signal: data.signal ?? "stable",
      source: "playerInSet",
    };
  } catch (err) {
    trackHttpDependency({
      name: "playerInSetMomentum_bridge",
      url: fullUrl,
      startMs: start,
      resultCode: 0,
      success: false,
      error: err as Error,
    });
    return { ...BRIDGE_NEUTRAL, source: "bridge_error" };
  }
}

/** SHADOW comparator: given the old (player-wide) compsMomentum from
 *  fn-serve-signals and the new (per-release) value from the bridge,
 *  compute the approximate shift the new value WOULD induce on
 *  signals.final_multiplier, and surface flag-flip booleans.
 *
 *  First-order approximation: the aggregator compounds
 *    final_pre_overlay = Σ w·m   (compsMomentum's weight is 0.20)
 *  then applies multiplicative overlays (show, pack, playoff, arc) and
 *  clamps to [0.70, 1.50]. We don't have the overlay product, so
 *  approximate final_new = final_old + (mult_new - mult_old) * 0.20.
 *  Overlays are typically near 1.0 → this is correct within ~5% in
 *  practice. Surfaced as `approximate_final_multiplier_new`. */
export function computeShadowDelta(args: {
  oldCompsMomentum: number;
  oldFlagsIncludes: { rising: boolean; falling: boolean; noData: boolean };
  oldFinalMultiplier: number;
  bridge: PlayerInSetMomentumBridgeResult;
}): {
  newCompsMomentum: number | null;
  newSignal: string | null;
  multDelta: number | null;
  approximateFinalMultiplierNew: number | null;
  flagWouldFlip: boolean;
  bridgeSource: PlayerInSetMomentumBridgeResult["source"];
} {
  if (args.bridge.multiplier === null) {
    return {
      newCompsMomentum: null,
      newSignal: null,
      multDelta: null,
      approximateFinalMultiplierNew: null,
      flagWouldFlip: false,
      bridgeSource: args.bridge.source,
    };
  }
  const newMult = args.bridge.multiplier;
  const multDelta = newMult - args.oldCompsMomentum;
  const finalDelta = multDelta * COMPS_MOMENTUM_WEIGHT;
  const approxFinal = Math.max(0.70, Math.min(1.50, args.oldFinalMultiplier + finalDelta));
  const newRising = args.bridge.signal === "rising";
  const newFalling = args.bridge.signal === "falling";
  const flagWouldFlip =
    args.oldFlagsIncludes.rising !== newRising
    || args.oldFlagsIncludes.falling !== newFalling;
  return {
    newCompsMomentum: newMult,
    newSignal: args.bridge.signal,
    multDelta,
    approximateFinalMultiplierNew: Math.round(approxFinal * 1000) / 1000,
    flagWouldFlip,
    bridgeSource: args.bridge.source,
  };
}

/** Apply the bridge override to the signals payload returned by
 *  fn-serve-signals. When bridge.multiplier is non-null:
 *    - Replace signals.components.compsMomentum with bridge.multiplier
 *    - Recompute signals.final_multiplier under the aggregator's 0.20
 *      weight (first-order: oldFinal + (newCM - oldCM) * 0.20, clamped
 *      [0.70, 1.50]). Ignores overlay multipliers (show/pack/playoff/
 *      arc) which are typically ~1.0 and unknowable post-hoc — within
 *      ~5% in practice.
 *    - Swap signals.signal_flags: remove any compsMomentum_* flag, add
 *      the one matching bridge.signal.
 *    - Update signals.component_signals.compsMomentum to the bridge
 *      direction for prompt clarity.
 *  When bridge.multiplier is null: return signals unchanged. */
export function applyPlayerInSetBridge(
  signals: SignalPayload,
  bridge: PlayerInSetMomentumBridgeResult,
): SignalPayload {
  if (bridge.multiplier === null) return signals;

  const oldCM = signals.components?.compsMomentum ?? 1.0;
  const oldFinal = signals.final_multiplier ?? 1.0;
  const newCM = bridge.multiplier;
  const cmDelta = newCM - oldCM;
  const newFinal = Math.max(
    0.70,
    Math.min(1.50, oldFinal + cmDelta * COMPS_MOMENTUM_WEIGHT),
  );

  // Strip any existing compsMomentum_* flag; add the new one. The
  // aggregator emits rising/falling/no_data; the bridge emits
  // rising/falling/stable. We map stable → DROP the flag (not in the
  // aggregator's vocabulary) and let the no-flag case mean "stable".
  const filteredFlags = (signals.signal_flags ?? []).filter(
    (f) => f !== "compsMomentum_rising"
        && f !== "compsMomentum_falling"
        && f !== "compsMomentum_no_data",
  );
  const newFlags = [...filteredFlags];
  if (bridge.signal === "rising") newFlags.push("compsMomentum_rising");
  else if (bridge.signal === "falling") newFlags.push("compsMomentum_falling");

  // component_signals is { [signal]: <direction string> } per the
  // aggregator's output shape. Mirror the new direction so prompt-
  // adjacent reads of that map see the same value as components.
  const newComponentSignals = { ...(signals.component_signals ?? {}) };
  if (bridge.signal === "rising" || bridge.signal === "falling" || bridge.signal === "stable") {
    newComponentSignals.compsMomentum = bridge.signal;
  }

  return {
    ...signals,
    final_multiplier: Math.round(newFinal * 1000) / 1000,
    signal_flags: newFlags,
    components: {
      ...(signals.components ?? {}),
      compsMomentum: Math.round(newCM * 1000) / 1000,
    },
    component_signals: newComponentSignals,
  };
}

// -------------------------------------------------------------------------
// H6 — Price floor fetch
// -------------------------------------------------------------------------

interface FloorResponse {
  floor: number | null;
  comp_count_90d?: number;
  updated_at?: string;
}

export async function fetchPriceFloor(
  cardId: string
): Promise<FloorResponse | null> {
  if (!FLOOR_URL || !cardId) return null;

  const url = new URL(FLOOR_URL);
  url.searchParams.set("cardId", cardId);
  if (FLOOR_KEY) url.searchParams.set("code", FLOOR_KEY);
  const fullUrl = url.toString();
  const start = Date.now();

  // CF-FETCH-SIGNAL-FLOOR-TELEMETRY: same pattern as fetchSignals above.
  // Note: 404 here often means "no floor stored yet" (legitimate empty state),
  // not a misconfiguration — but we still record it as success=false so the
  // operator can distinguish (a) no floors ever stored vs (b) all floors
  // returning 404 because the URL path is wrong.
  try {
    const resp = await fetch(fullUrl, {
      signal: AbortSignal.timeout(5_000),
    });
    trackHttpDependency({
      name: "price_floor_service",
      url: fullUrl,
      startMs: start,
      resultCode: resp.status,
      success: resp.ok,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as Partial<FloorResponse>;
    if (!Number.isFinite(Number(data.floor))) return null;
    return {
      floor: Number(data.floor),
      comp_count_90d: data.comp_count_90d,
      updated_at: data.updated_at,
    };
  } catch (err) {
    trackHttpDependency({
      name: "price_floor_service",
      url: fullUrl,
      startMs: start,
      resultCode: 0,
      success: false,
      error: err as Error,
    });
    return null;
  }
}

function applyPriceFloor(
  result: PriceResult,
  floor: number | null
): PriceResult {
  if (floor === null || !Number.isFinite(floor) || floor <= 0) {
    return result;
  }
  let applied = false;
  let p72 = result.predicted_price_72h;
  let p7 = result.predicted_price_7d;
  if (p72 < floor) {
    p72 = floor;
    applied = true;
  }
  if (p7 < floor) {
    p7 = floor;
    applied = true;
  }
  if (!applied) {
    return { ...result, floor_value: floor };
  }
  const flags = new Set(result.risk_flags);
  flags.add(`price_floor_enforced: $${floor.toFixed(2)}`);
  return {
    ...result,
    predicted_price_72h: round2(p72),
    predicted_price_7d: round2(p7),
    floor_applied: true,
    floor_value: floor,
    risk_flags: Array.from(flags),
  };
}

// -------------------------------------------------------------------------
// Volatility & risk pre-flags (computed locally, then passed to model)
// -------------------------------------------------------------------------

function preflightRiskFlags(card: Card, signals: SignalPayload): string[] {
  const flags: string[] = [];
  const now = Date.now();
  const dayMs = 86_400_000;

  const compsLast30 = card.recentComps.filter(
    (c) => now - new Date(c.date).getTime() <= 30 * dayMs
  );
  const compsLast7 = card.recentComps.filter(
    (c) => now - new Date(c.date).getTime() <= 7 * dayMs
  );

  if (compsLast30.length < 5) flags.push("thin_market_lt_5_comps_30d");

  if (compsLast7.length >= 3) {
    const avg7 = average(compsLast7.map((c) => c.price));
    const avg30 = compsLast30.length
      ? average(compsLast30.map((c) => c.price))
      : avg7;
    if (avg30 > 0 && (avg7 - avg30) / avg30 > 0.4) {
      flags.push("artificial_spike_gt_40pct_7d");
    }
  }

  if (signals.signal_flags?.includes("injury_risk")) flags.push("injury_risk");
  if (signals.signal_flags?.includes("player_slump")) {
    flags.push("lagging_decline_candidate");
  }
  if (
    (signals.signal_flags?.includes("reddit_buzz") ||
      signals.signal_flags?.includes("search_spike")) &&
    !signals.signal_flags?.includes("ebay_demand_high")
  ) {
    flags.push("unconfirmed_hype_social_only");
  }

  if (signals.updated_at) {
    const ageHr =
      (now - new Date(signals.updated_at).getTime()) / (1000 * 60 * 60);
    if (ageHr > 6) flags.push("stale_signals");
  } else {
    flags.push("stale_signals");
  }

  return flags;
}

// -------------------------------------------------------------------------
// Prompt
// -------------------------------------------------------------------------

function buildPricingPrompt(
  card: Card,
  signals: SignalPayload,
  preFlags: string[],
  comp: CompGating,
  floorValue: number | null,
  analytics: CompsAnalytics,
  catalyst: CatalystResult
): string {
  const compsBlock = card.recentComps.length
    ? card.recentComps
        .map(
          (c) =>
            `- $${c.price.toFixed(2)} on ${c.date} (${c.grade}${
              c.source ? `, ${c.source}` : ""
            })`
        )
        .join("\n")
    : "- (no recent comps)";

  // M3 + M7 + M8 — deterministic card-level modifiers.
  const cardMods = combinedCardModifiers({
    cardYear: card.year,
    isRookie: !!card.isRookie,
    grade: card.grade,
    jerseyNumber: card.jerseyNumber,
    printRun: card.printRun,
  });

  return `
You are CompIQ's predictive pricing engine for baseball cards.
Goal: predict where this card's price is GOING in the next 3-7 days.
NOT what it sold for yesterday. Where it will sell TOMORROW.

## The Anti-Yesterday Rule
Before finalizing, verify your prediction reflects where the market is TODAY
and GOING — not just completed sales from the past. If your number lands
within 2% of the 30-day comp average, justify it explicitly OR diverge with
a clear reason.

## Card Details
Player: ${card.playerName}
Year: ${card.year} | Set: ${card.set} | Card #: ${card.cardNumber}
Grade: ${card.grade ?? "raw"} | Variant: ${card.variant ?? "base"}
Print Run: ${card.printRun ? `/${card.printRun}` : "unlimited"}
Rookie: ${card.isRookie ? "yes" : "no"}
Jersey #: ${card.jerseyNumber ?? "n/a"}

## Card-Level Modifier (deterministic, computed from card metadata)
- Rookie-year timing: ${cardMods.rookie_year}x (M3 — premium fades over 3 years)
- Grade premium:      ${cardMods.grade}x (M8)
- Jersey icon:        ${cardMods.jersey}x${
    cardMods.jersey_icon ? ` — ${cardMods.jersey_icon}` : ""
  } (M7)
- Print run:          ${cardMods.print_run}x
- Combined card mod:  ${cardMods.combined}x (clamped 0.70–1.50)

## Anchor Price
$${card.anchorPrice.toFixed(2)}

## Recent Comps (most recent first)
${compsBlock}

## Time-Series Analytics (computed from cached sales — TREAT AS PRIMARY INPUT)
${renderAnalyticsBlock(analytics)}

Use these analytics to drive your prediction. Specifically:
- If acceleration = accelerating_up AND volume rising: predict continuation, raise 7d > 72h.
- If acceleration = accelerating_up AND volume falling: predict reversal, lower 7d, flag as unstable.
- If acceleration = accelerating_down: predict continued decline, recommend move now.
- If trend = volatile: widen confidence interval, flag as volatile.
- The recency-weighted VWAP is your STRONGEST single anchor for the 72-hour prediction.
- Anti-yesterday divergence > 15% means recent sales are diverging from the 30-day baseline — this is a SIGNAL, not noise.

## Live Market Signals (refreshed every 2-6 hours)
Final Signal Multiplier: ${signals.final_multiplier}x
Predicted Direction: ${signals.predicted_direction ?? "unknown"}
Active Flags: ${signals.signal_flags?.join(", ") || "none"}

Signal Breakdown:
- eBay demand:     ${signals.components?.ebay ?? 1.0}x
- Reddit buzz:     ${signals.components?.reddit ?? 1.0}x
- Google Trends:   ${signals.components?.trends ?? 1.0}x
- Award odds:      ${signals.components?.odds ?? 1.0}x
- Stats momentum:  ${signals.components?.stats ?? 1.0}x
- News sentiment:  ${signals.components?.news ?? 1.0}x
- YouTube hype:    ${signals.components?.youtube ?? 1.0}x

## Pre-flight risk flags (already detected — include in risk_flags)
${preFlags.length ? preFlags.map((f) => `- ${f}`).join("\n") : "- none"}

## Market Structure
- BIN Price Trend:    ${signals.bin_signal ?? "unknown"} (${
    signals.bin_drop_pct ?? 0
  }% vs 14-day rolling avg)
- Sell-Through Rate:  ${
    signals.sell_through_rate ?? "unknown"
  } (${signals.str_signal ?? "unknown"})
- Market Depth:       ${comp.market_depth} (${comp.comp_count_30d} comps in last 30 days, ${comp.price_variance_pct}% spread)
- Show Calendar:      ${signals.show_phase ?? "none"}${
    signals.show_name ? ` — ${signals.show_name}` : ""
  }${
    signals.days_to_show !== null && signals.days_to_show !== undefined
      ? ` (${signals.days_to_show} days)`
      : ""
  }
- Pack Release:       ${signals.release_phase ?? "none"}${
    signals.release_name ? ` — ${signals.release_name}` : ""
  }${
    signals.days_to_release !== null && signals.days_to_release !== undefined
      ? ` (${signals.days_to_release} days)`
      : ""
  } [${signals.release_multiplier ?? 1.0}x]
- Playoff Status:     ${signals.playoff_signal ?? "none"}${
    signals.playoff_window ? ` — ${signals.playoff_window}` : ""
  } [${signals.playoff_multiplier ?? 1.0}x]
- Career Arc:         ${
    signals.career_arc_signal && signals.career_arc_signal.length
      ? signals.career_arc_signal.join(", ")
      : "none"
  } [${signals.career_arc_multiplier ?? 1.0}x]
- Price Floor (90d):  ${
    floorValue !== null ? `$${floorValue.toFixed(2)} (hard minimum)` : "none stored"
  }
- Static Catalyst:    ${
    catalyst.in_window
      ? `${catalyst.name} (${catalyst.type}, ${catalyst.days_until}d away, ${catalyst.multiplier}x)`
      : "none in pre-window"
  }

## Confidence Constraint
Maximum confidence you may assign for this card: ${comp.max_confidence}
You MUST NOT exceed this ceiling — it reflects comp depth and price variance.

## Card-Level Pricing Weights (apply BEFORE signal multiplier)
- Rookie card (RC):   +15 to +25%
- 1st Edition:        +10 to +20%
- Print run /25:      +40 to +60%
- Print run /100:     +20 to +30%
- Print run /250:     +10 to +15%
- PSA 10 / BGS 9.5:   +30 to +50% vs raw
- PSA 9:              +10 to +20% vs raw
- Refractor/parallel: +10 to +30%

## Catalyst Detection
Scan for upcoming events (next 7-14 days) that will move price:
playoff games, MVP/Cy Young/HOF announcements, PWCC/Goldin auctions,
new set releases, trade rumors, free-agency signings. Apply a catalyst
multiplier of 0.85-1.40 depending on magnitude. If detected, set
catalyst_detected=true and explain in catalyst_detail.

## Confidence Calibration
Reduce confidence: <3 comps in 21d, signals disagreeing, player slump but
price still rising, broader market correction, stale signals.
Increase confidence: 10+ comps in 14d w/ tight variance, all signals
agreeing, momentum consistent 14+ days, repeat-buyer floor.

## Instructions
1. Apply card-level weights to the anchor price first.
2. Then apply the signal multiplier as your starting predicted price.
3. Predict 72-hour and 7-day prices SEPARATELY — they should diverge.
4. Set confidence (0-100) based on comp volume, signal agreement, flag severity.
5. Identify the top 3 specific drivers of this prediction.
6. Recommend the best time to sell.
7. Include all pre-flight risk flags above plus any new ones you detect.
8. NEVER use the 30-day average as the prediction without adjustment.
9. Provide AT LEAST 2 key_drivers and a non-empty confidence_reason.

Return ONLY valid JSON matching this exact schema:
{
  "predicted_price_72h": 0.00,
  "predicted_price_7d": 0.00,
  "predicted_direction": "rising | falling | stable | volatile",
  "confidence": 0,
  "confidence_reason": "string",
  "key_drivers": ["string", "string", "string"],
  "risk_flags": ["string"],
  "best_time_to_sell": "now | 3 days | 7 days | hold",
  "catalyst_detected": true,
  "catalyst_detail": "string or null"
}
`.trim();
}

// -------------------------------------------------------------------------
// Output validation — schema is enforced even if the model misbehaves.
// -------------------------------------------------------------------------

class PriceResultError extends Error {}

function validatePriceResult(raw: unknown): PriceResult {
  if (!raw || typeof raw !== "object") {
    throw new PriceResultError("Model returned non-object response");
  }
  const r = raw as Record<string, unknown>;

  const num = (key: string): number => {
    const v = Number(r[key]);
    if (!Number.isFinite(v)) {
      throw new PriceResultError(`Missing or non-numeric '${key}'`);
    }
    return v;
  };
  const str = (key: string): string => {
    const v = r[key];
    if (typeof v !== "string" || !v.trim()) {
      throw new PriceResultError(`Missing or empty '${key}'`);
    }
    return v;
  };
  const arr = (key: string): string[] => {
    const v = r[key];
    if (!Array.isArray(v)) {
      throw new PriceResultError(`'${key}' must be an array`);
    }
    return v.map((x) => String(x));
  };

  const direction = String(r.predicted_direction ?? "stable");
  if (!["rising", "falling", "stable", "volatile"].includes(direction)) {
    throw new PriceResultError(
      `Invalid predicted_direction '${direction}'`
    );
  }
  const sell = String(r.best_time_to_sell ?? "hold");
  if (!["now", "3 days", "7 days", "hold"].includes(sell)) {
    throw new PriceResultError(`Invalid best_time_to_sell '${sell}'`);
  }

  const confidence = Math.max(0, Math.min(100, Math.round(num("confidence"))));

  const key_drivers = arr("key_drivers").filter((s) => s.trim().length > 0);
  if (key_drivers.length < 2) {
    throw new PriceResultError(
      "key_drivers must contain at least 2 non-empty entries"
    );
  }

  return {
    predicted_price_72h: round2(num("predicted_price_72h")),
    predicted_price_7d: round2(num("predicted_price_7d")),
    predicted_direction: direction as PriceResult["predicted_direction"],
    confidence,
    confidence_reason: str("confidence_reason"),
    key_drivers,
    risk_flags: Array.isArray(r.risk_flags)
      ? r.risk_flags.map(String)
      : [],
    best_time_to_sell: sell as PriceResult["best_time_to_sell"],
    catalyst_detected: Boolean(r.catalyst_detected),
    catalyst_detail:
      typeof r.catalyst_detail === "string" ? r.catalyst_detail : null,
  };
}

// -------------------------------------------------------------------------
// Public entry point
// -------------------------------------------------------------------------

export interface GetPredictedPriceOptions {
  // Backtest-only: bypass fetchSignals and inject a pre-captured (or neutral)
  // SignalPayload directly into the prompt. Used by the synthetic backtest
  // harness (mcp-server/scripts/backtest_signal_value.ts) to compare
  // signal-on vs signal-off arms with deterministic signal context.
  // Production paths MUST NOT pass this — they should always fetchSignals.
  signalsOverride?: SignalPayload;
}

export async function getPredictedPrice(
  card: Card,
  options?: GetPredictedPriceOptions
): Promise<PriceResult> {
  if (!card.playerName) {
    throw new Error("getPredictedPrice: card.playerName is required");
  }
  if (!Number.isFinite(card.anchorPrice) || card.anchorPrice <= 0) {
    throw new Error("getPredictedPrice: card.anchorPrice must be > 0");
  }

  // H10 — comp gating computed locally; ceiling enforced after model returns.
  const comp = evaluateCompGating(card);

  // H6 — fetch stored 90-day price floor for this card (best-effort).
  const cardId = [
    card.playerName,
    card.year,
    card.set,
    card.cardNumber,
    card.grade ?? "raw",
    card.variant ?? "base",
  ]
    .map((s) => String(s).trim())
    .join("|");
  const [signalsRaw, floorDoc, playerInSetBridge] = await Promise.all([
    options?.signalsOverride
      ? Promise.resolve(options.signalsOverride)
      : fetchSignals(card.playerName),
    fetchPriceFloor(cardId),
    // CF-MCP-PLAYER-IN-SET-BRIDGE (2026-06-10): fetch the per-(player,
    // release, year) momentum in parallel with fetchSignals. Bridge
    // runs ONLY in production paths (signalsOverride means backtest
    // harness — don't double-fetch for synthetic runs).
    options?.signalsOverride
      ? Promise.resolve<PlayerInSetMomentumBridgeResult>({
          multiplier: null,
          signal: null,
          source: "bridge_unavailable",
        })
      : fetchPlayerInSetMomentumBridge(card.playerName, card.set, card.year),
  ]);
  const floorValue = floorDoc?.floor ?? null;

  // CF-MCP-PLAYER-IN-SET-BRIDGE (2026-06-10) — CUTOVER (was SHADOW).
  //
  // When the bridge returns a non-null per-(player, release, year)
  // multiplier, REPLACE signals.components.compsMomentum with the
  // bridge value, recompute signals.final_multiplier under the
  // aggregator's 0.20 weight, and swap the compsMomentum_* flag.
  //
  // When the bridge returns null (≤1 qualifying cards, network
  // failure, etc.), fall back to the player-wide value — current
  // behavior preserved, no alert impact.
  //
  // Shadow probe across 10 tracked cards showed: bridge has data
  // ~40% of the time. Where it does, the OLD aggregator was reading
  // some megastars (Judge, Ohtani) as ceiling-clamped rising — a
  // per-player rollup pathology that fetchPlayerInSetMomentum's
  // per-card median ratio corrects. Median |final_multiplier shift|
  // 0.062, max 0.067 on the cards where bridge had data.
  //
  // Single grep-key log line per /predict call:
  //   [mcp.compsMomentum_bridge] ... cutover_applied=true/false
  const signals = applyPlayerInSetBridge(signalsRaw, playerInSetBridge);

  if (!options?.signalsOverride) {
    try {
      const oldCM = signalsRaw.components?.compsMomentum ?? 1.0;
      const oldFlags = signalsRaw.signal_flags ?? [];
      const newCM = signals.components?.compsMomentum ?? oldCM;
      const newFlags = signals.signal_flags ?? [];
      const cutoverApplied = playerInSetBridge.multiplier !== null;
      const cmDelta = cutoverApplied ? newCM - oldCM : 0;
      console.log(
        `[mcp.compsMomentum_bridge] ` +
          `player="${(card.playerName ?? "").slice(0, 32)}" ` +
          `release="${(card.set ?? "").slice(0, 40)}" ` +
          `year=${card.year} ` +
          `cutover_applied=${cutoverApplied} ` +
          `old_cm=${oldCM.toFixed(3)} ` +
          `new_cm=${newCM.toFixed(3)} ` +
          `cm_delta=${cmDelta.toFixed(3)} ` +
          `old_final=${(signalsRaw.final_multiplier ?? 1.0).toFixed(3)} ` +
          `new_final=${(signals.final_multiplier ?? 1.0).toFixed(3)} ` +
          `old_signal_rising=${oldFlags.includes("compsMomentum_rising")} ` +
          `old_signal_falling=${oldFlags.includes("compsMomentum_falling")} ` +
          `new_signal_rising=${newFlags.includes("compsMomentum_rising")} ` +
          `new_signal_falling=${newFlags.includes("compsMomentum_falling")} ` +
          `new_signal_no_data=${newFlags.includes("compsMomentum_no_data")} ` +
          `bridge_source=${playerInSetBridge.source}`,
      );
    } catch {
      // Telemetry must never throw.
    }
  }

  // Phase A — compute time-series analytics over cached comps
  const analytics = computeCompsAnalytics(card.recentComps);
  const analyticsFlags = analyticsRiskFlags(analytics);

  // Phase D — static catalyst fallback (only used to enrich the prompt;
  // signal-aggregator's data still wins when present)
  const catalyst = lookupCatalyst();

  const preFlags = [
    ...preflightRiskFlags(card, signals),
    ...analyticsFlags,
  ];
  const prompt = buildPricingPrompt(
    card,
    signals,
    preFlags,
    comp,
    floorValue,
    analytics,
    catalyst
  );

  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    max_tokens: 600,
    ...OPENAI_DETERMINISTIC_CONFIG,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }],
  });

  const content = response.choices[0]?.message?.content ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("OpenAI returned invalid JSON for pricing prediction");
  }

  let result = validatePriceResult(parsed);

  // Merge pre-flight + comp gating risk flags the model omitted.
  const merged = new Set([
    ...result.risk_flags,
    ...preFlags,
    ...comp.comp_flags,
  ]);
  result.risk_flags = Array.from(merged);

  // H10 — enforce comp-volume confidence ceiling.
  result.confidence = Math.min(result.confidence, comp.max_confidence);
  result.max_confidence = comp.max_confidence;

  // H6 — final floor enforcement: never predict below the 90-day floor.
  result = applyPriceFloor(result, floorValue);

  // Surface analytics for client + Cosmos audit log.
  result.analytics = analytics;

  return result;
}

// -------------------------------------------------------------------------
// utils
// -------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function average(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

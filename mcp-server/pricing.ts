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

const SIGNAL_URL = process.env.AZURE_SIGNAL_FUNCTION_URL ?? "";
const SIGNAL_KEY = process.env.AZURE_SIGNAL_FUNCTION_KEY ?? "";
const FLOOR_URL = process.env.AZURE_PRICE_FLOOR_URL ?? "";
const FLOOR_KEY = process.env.AZURE_PRICE_FLOOR_KEY ?? "";

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

  try {
    const url = new URL(SIGNAL_URL);
    url.searchParams.set("player", playerName);
    if (SIGNAL_KEY) url.searchParams.set("code", SIGNAL_KEY);

    const resp = await fetch(url.toString(), {
      // 5s budget — pricing is interactive, can't block on a slow blob fetch
      signal: AbortSignal.timeout(5_000),
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
  } catch {
    return { ...NEUTRAL_SIGNAL };
  }
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
  try {
    const url = new URL(FLOOR_URL);
    url.searchParams.set("cardId", cardId);
    if (FLOOR_KEY) url.searchParams.set("code", FLOOR_KEY);
    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as Partial<FloorResponse>;
    if (!Number.isFinite(Number(data.floor))) return null;
    return {
      floor: Number(data.floor),
      comp_count_90d: data.comp_count_90d,
      updated_at: data.updated_at,
    };
  } catch {
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
  const [signals, floorDoc] = await Promise.all([
    options?.signalsOverride
      ? Promise.resolve(options.signalsOverride)
      : fetchSignals(card.playerName),
    fetchPriceFloor(cardId),
  ]);
  const floorValue = floorDoc?.floor ?? null;

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

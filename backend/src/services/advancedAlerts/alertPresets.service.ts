// CF-ALERT-PRESETS (Drew, 2026-07-17). Curated one-click templates
// for the advanced-alerts rule builder. Instead of having iOS render
// a full rule editor (scope × N conditions × combinators), we
// surface a small set of high-signal templates users can activate
// with a single tap. Behind the scenes each template resolves to a
// concrete AdvancedAlertRule shape.
//
// Presets are HARDCODED in this file — they represent the alerts we
// believe every serious seller wants running. New presets ship via
// PR, not via runtime config, so we own the quality bar.

import type {
  AdvancedAlertCondition,
  AdvancedAlertCombinator,
  AdvancedAlertScope,
} from "../../repositories/advancedAlertRules.repository.js";

export type PresetCategory = "portfolio_sell_signal" | "watchlist_move" | "grade_opportunity" | "market_dip";

export interface AlertPreset {
  presetId: string;              // stable slug
  name: string;                  // seller-facing rule name
  category: PresetCategory;
  description: string;           // one-line
  whyItMatters: string;          // sales-copy line
  scope: AdvancedAlertScope;
  combinator: AdvancedAlertCombinator;
  conditions: AdvancedAlertCondition[];
  cooldownMin: number;
}

const PRESETS: AlertPreset[] = [
  {
    presetId: "portfolio-sell-window-opens",
    name: "Sell window opens (portfolio)",
    category: "portfolio_sell_signal",
    description: "Ping me when a card I own is trending up + predicted moves 15%+ higher.",
    whyItMatters: "The window between spike and normalization is short. Get in early.",
    scope: { type: "holdings" },
    combinator: "AND",
    conditions: [
      { kind: "predicted_direction", equals: "up" },
      { kind: "predicted_pct_move", op: "gte", value: 0.15 },
      { kind: "trendiq_composite", op: "gte", value: 1.10 },
    ],
    cooldownMin: 720,   // 12h — sell moves cluster; don't spam
  },
  {
    presetId: "portfolio-price-target",
    name: "Card hits my price target",
    category: "portfolio_sell_signal",
    description: "Alert me when a holding's market value crosses a level I set.",
    whyItMatters: "Automated price target tracking without staring at the app.",
    scope: { type: "holdings" },
    combinator: "OR",   // fires if EITHER condition — user typically sets one
    conditions: [
      { kind: "price_crosses", op: "above", value: 0 },
    ],
    cooldownMin: 1440,  // once per day per target
  },
  {
    presetId: "watchlist-move-fast",
    name: "Watchlist card moves fast",
    category: "watchlist_move",
    description: "Predicted price on a watchlist card jumps 20%+ over the prior read.",
    whyItMatters: "Catch inflection points on cards you were considering buying.",
    scope: { type: "watchlist" },
    combinator: "AND",
    conditions: [
      { kind: "predicted_pct_move", op: "gte", value: 0.20 },
      { kind: "confidence_min", value: 0.6 },
    ],
    cooldownMin: 360,
  },
  {
    presetId: "watchlist-buy-window",
    name: "Watchlist card drops",
    category: "market_dip",
    description: "Predicted price on a watchlist card drops 15%+ — potential buy window.",
    whyItMatters: "Value plays surface fast; be the first bidder.",
    scope: { type: "watchlist" },
    combinator: "AND",
    conditions: [
      { kind: "predicted_direction", equals: "down" },
      { kind: "predicted_pct_move", op: "gte", value: 0.15 },
      { kind: "confidence_min", value: 0.6 },
    ],
    cooldownMin: 360,
  },
  {
    presetId: "portfolio-momentum-flip",
    name: "Momentum reverses on my card",
    category: "portfolio_sell_signal",
    description: "TrendIQ direction flips from up→down or down→up on a holding.",
    whyItMatters: "Reversal = time to reevaluate strategy on that SKU.",
    scope: { type: "holdings" },
    combinator: "OR",
    conditions: [
      { kind: "predicted_direction", equals: "down" },
      { kind: "trendiq_composite", op: "lte", value: 0.95 },
    ],
    cooldownMin: 1440,
  },
];

export function listAlertPresets(): AlertPreset[] {
  return PRESETS;
}

export function getAlertPreset(presetId: string): AlertPreset | null {
  return PRESETS.find((p) => p.presetId === presetId) ?? null;
}

/** Materialize a preset into the exact rule shape the repository
 *  expects. `params` merges any user-supplied overrides (e.g. price
 *  target value for portfolio-price-target). */
export function materializePreset(
  preset: AlertPreset,
  params?: {
    priceTarget?: number;
    customName?: string;
  },
): {
  name: string;
  scope: AdvancedAlertScope;
  combinator: AdvancedAlertCombinator;
  conditions: AdvancedAlertCondition[];
  cooldownMin: number;
} {
  const conditions = preset.conditions.map((c) => {
    if (c.kind === "price_crosses" && params?.priceTarget !== undefined && params.priceTarget > 0) {
      return { ...c, value: params.priceTarget };
    }
    return c;
  });
  return {
    name: params?.customName ?? preset.name,
    scope: preset.scope,
    combinator: preset.combinator,
    conditions,
    cooldownMin: preset.cooldownMin,
  };
}

export const _PRESET_IDS_FOR_TESTS = PRESETS.map((p) => p.presetId);

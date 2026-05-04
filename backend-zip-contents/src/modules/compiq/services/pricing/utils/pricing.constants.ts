// Centralized constants for pricing engines

export const DEFAULT_MARKET_FEE_PCT = 0.13;
export const DEFAULT_SHIPPING_COST = 5;
export const SCORE_CLAMP_MIN = 0;
export const SCORE_CLAMP_MAX = 100;

// Tunable multipliers and thresholds
export const REGIME_MULTIPLIER_RANGE = { min: 0.90, max: 1.10 };
export const TIMING_MULTIPLIER_RANGE = { min: 0.90, max: 1.15 };
export const RISK_MULTIPLIER_RANGE = { min: 0.80, max: 1.00 };
export const LIQUIDITY_MULTIPLIER_RANGE = { min: 0.92, max: 1.08 };
export const HOBBY_PREMIUM_MAX = 1.15;
export const POP_PRESSURE_MIN = 0.85;

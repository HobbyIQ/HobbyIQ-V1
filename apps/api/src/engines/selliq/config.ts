// Config for SellIQ pricing and strategy rules

export const LIQUIDITY_FLOOR_THRESHOLDS = {
  low: 0.92,   // Use 92% of riskAdjustedFMV if liquidity is low
  normal: 0.97 // Use 97% of riskAdjustedFMV if liquidity is normal/high
};

export const URGENCY_THRESHOLDS = {
  high: 70,
  low: 30
};

export const MOMENTUM_BONUS = 0.05; // 5% bonus to list price if momentum is strong
export const NEG_PRESSURE_PENALTY = 0.95; // 5% penalty to list price if negative pressure is high

export const REPRICING_PLANS = {
  default: 'Review price every 7 days; reduce by 5% if unsold.',
  aggressive: 'Reduce price by 10% every 3 days until sold.',
  patient: 'Hold price steady for 10 days, then review.'
};

// Config for Decision Engine scoring and thresholds

export const SCORING_WEIGHTS = {
  playerIQ: 0.3,
  dailyIQ: 0.2,
  compTrend: 0.2,
  supplyScarcity: 0.15,
  liquidity: 0.1,
  negativePressurePenalty: 1.0, // Multiplier for penalty
};

export const RECOMMENDATION_THRESHOLDS = {
  strong_buy: 85,
  buy: 70,
  hold: 50,
  sell: 30,
  strong_sell: 0,
};

export const CONFIDENCE_THRESHOLDS = {
  high: 80,
  medium: 60,
  low: 0,
};

export const URGENCY_THRESHOLDS = {
  high: 80,
  medium: 50,
  low: 0,
};

export const TIME_HORIZON_THRESHOLDS = {
  short: 80,
  medium: 50,
  long: 0,
};

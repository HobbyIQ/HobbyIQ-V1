// pricingDefaults.js - Baseline multipliers and config for fallback
module.exports = {
  baseToGold: 1.8,
  goldToOrange: 1.22,
  orangeToRed: 1.36,
  redToSuper: 1.67,
  defaultConfidence: 0.7,
  minCompsForHighConfidence: 4,
  minCompsForMediumConfidence: 2,
  outlierIQRMultiplier: 1.5,
  trendWindow: 6,
  trendStrengthThreshold: 0.08
};

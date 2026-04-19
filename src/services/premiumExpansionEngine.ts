import { Trend, Liquidity, EstimateInput } from '../models/compiq';

export function expandPremium(input: EstimateInput, trend: Trend, liquidity: Liquidity) {
  // Market Pressure Score (0–100)
  const playerMomentum = input.playerMomentum ?? 50;
  const performance = input.performance ?? 50;
  let trendScore = 0;
  switch (trend) {
    case 'strong_up': trendScore = 30; break;
    case 'mild_up': trendScore = 15; break;
    case 'flat': trendScore = 0; break;
    case 'mild_down': trendScore = -10; break;
    case 'strong_down': trendScore = -20; break;
  }
  let supplyScore = 0;
  switch (liquidity) {
    case 'high': supplyScore = 0; break;
    case 'medium': supplyScore = 10; break;
    case 'low': supplyScore = 25; break;
    case 'illiquid': supplyScore = 40; break;
  }
  // Comp velocity: use as 10–30
  const compVelocity = Math.max(10, Math.min(30, 100 - supplyScore));
  const marketPressureScore = Math.max(0, Math.min(100, playerMomentum + performance + trendScore + supplyScore + compVelocity) / 3);
  let expansion = 0;
  if (marketPressureScore < 30) expansion = 0.05;
  else if (marketPressureScore < 60) expansion = 0.15;
  else if (marketPressureScore < 80) expansion = 0.3;
  else expansion = 0.5;
  return {
    applied: expansion > 0,
    marketPressureScore,
    expansion
  };
}

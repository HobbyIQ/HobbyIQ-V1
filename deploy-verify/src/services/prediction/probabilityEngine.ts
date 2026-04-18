import { CardEvent } from './eventModel';

export function getProbability(payload: any, events: CardEvent[], eventConfidence: number) {
  // Player signal score
  let playerSignalScore = 0.5;
  if (payload.playerSignal === 'positive') playerSignalScore = 0.8;
  if (payload.playerSignal === 'negative') playerSignalScore = 0.2;
  // Trend strength
  let trendStrength = 0.5;
  if (payload.trendStrength === 'strong') trendStrength = 0.8;
  if (payload.trendStrength === 'moderate') trendStrength = 0.6;
  if (payload.trendStrength === 'low') trendStrength = 0.4;
  // Probability
  const probability = (playerSignalScore * 0.4) + (trendStrength * 0.3) + (eventConfidence * 0.3);
  return Math.max(0.05, Math.min(probability, 0.99));
}

// CompIQ Service - Pricing Engine Integration Phase 1
const { priceCard } = require('../shared/pricingEngine');
const sampleComps = require('../test-data/sampleComps');

async function getPriceResult(query, opts = {}) {
  // Use mock data for Phase 1
  return priceCard(query, sampleComps, { mock: true, useCache: true, ...opts });
}

module.exports = { getPriceResult };
// services/compiqService.js
module.exports.analyze = async function (input) {
  try {
    if (!input || !Array.isArray(input.recentComps) || input.recentComps.length === 0) {
      throw new Error('Missing or invalid recentComps');
    }
    // Weighted average (more recent comps weighted higher)
    const weights = input.recentComps.map((_, i, arr) => (i + 1) / arr.length);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const estimatedValue = input.recentComps.reduce((sum, val, i) => sum + val * weights[i], 0) / totalWeight;
    const low = Math.min(...input.recentComps);
    const high = Math.max(...input.recentComps);
    // Simple trend: compare last and first
    let trend = 'flat';
    if (input.recentComps.length > 1) {
      if (input.recentComps[input.recentComps.length - 1] > input.recentComps[0]) trend = 'up';
      else if (input.recentComps[input.recentComps.length - 1] < input.recentComps[0]) trend = 'down';
    }
    // Confidence: more comps = higher confidence
    const confidence = Math.round(Math.min(1, input.recentComps.length / 10) * 100);
    // Recommendation
    let recommendation = 'hold';
    if (trend === 'up' && confidence > 50) recommendation = 'buy';
    if (trend === 'down' && confidence > 50) recommendation = 'sell';
    return {
      estimatedValue: Math.round(estimatedValue),
      low,
      high,
      confidence,
      trend,
      recommendation
    };
  } catch (err) {
    throw err;
  }
};

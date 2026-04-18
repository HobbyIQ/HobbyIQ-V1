// PlayerIQ Service - Pricing Engine Integration Phase 1
const { priceCard } = require('../shared/pricingEngine');
const sampleComps = require('../test-data/sampleComps');

async function getPricingSummary(query, opts = {}) {
  // Use mock data for Phase 1
  return priceCard(query, sampleComps, { mock: true, useCache: true, ...opts });
}

module.exports = { getPricingSummary };
// services/playeriqService.js
module.exports.analyze = async function (input) {
  try {
    if (!input || !input.stats || typeof input.stats.ops !== 'number' || typeof input.stats.hr !== 'number' || typeof input.stats.avg !== 'number') {
      throw new Error('Missing or invalid stats');
    }
    // Scoring: OPS (x60) + HR (x2) + AVG (x40)
    let score = (input.stats.ops * 60) + (input.stats.hr * 2) + (input.stats.avg * 40);
    score = Math.round(Math.max(0, Math.min(100, score)));
    let tier = 'Risk';
    if (score >= 90) tier = 'Elite';
    else if (score >= 75) tier = 'Strong';
    else if (score >= 60) tier = 'Watch';
    // Card strategy
    const cardStrategy = {
      buy: [],
      hold: [],
      sell: []
    };
    if (tier === 'Elite') {
      cardStrategy.buy = ['Gold', 'Orange', 'Red'];
      cardStrategy.hold = ['Blue', 'Green'];
      cardStrategy.sell = ['Base', 'Paper'];
    } else if (tier === 'Strong') {
      cardStrategy.buy = ['Gold', 'Orange'];
      cardStrategy.hold = ['Blue'];
      cardStrategy.sell = ['Base'];
    } else if (tier === 'Watch') {
      cardStrategy.buy = ['Orange'];
      cardStrategy.hold = ['Base', 'Blue'];
      cardStrategy.sell = [];
    } else {
      cardStrategy.buy = [];
      cardStrategy.hold = ['Base'];
      cardStrategy.sell = ['All Parallels'];
    }
    return {
      playerScore: score,
      tier,
      cardStrategy
    };
  } catch (err) {
    throw err;
  }
};

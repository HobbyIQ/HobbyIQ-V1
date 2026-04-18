// multiplierEngine.js - Historical multiplier logic
const parallels = require('../config/parallels');
const pricingDefaults = require('../config/pricingDefaults');

function estimateMultiplier(fromTier, toTier, compData) {
  // Try to find direct comps for both tiers
  const fromComps = compData.filter(c => c.parallelBucket === fromTier);
  const toComps = compData.filter(c => c.parallelBucket === toTier);
  if (fromComps.length && toComps.length) {
    // Use median ratio
    const ratios = [];
    fromComps.forEach(from => {
      toComps.forEach(to => {
        if (from.salePrice && to.salePrice) {
          ratios.push(to.salePrice / from.salePrice);
        }
      });
    });
    if (ratios.length) {
      const sorted = ratios.sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      return { estimatedMultiplier: median, multiplierSource: 'direct', sourceBreakdown: {ratios} };
    }
  }
  // Fallback to config
  const fromObj = parallels.find(p => p.canonicalName === fromTier);
  const toObj = parallels.find(p => p.canonicalName === toTier);
  if (fromObj && toObj) {
    const est = toObj.relativeStrength / fromObj.relativeStrength;
    return { estimatedMultiplier: est, multiplierSource: 'config', sourceBreakdown: {from: fromObj, to: toObj} };
  }
  return { estimatedMultiplier: 1, multiplierSource: 'default', sourceBreakdown: {} };
}

module.exports = { estimateMultiplier };

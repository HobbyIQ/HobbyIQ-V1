// normalizationService.js - Card normalization logic
const parallels = require('../config/parallels');

function normalizeCardTitle(title) {
  // Simple regex-based normalization for Phase 1
  // Example: "2025 Bowman Chrome Josiah Hartshorn Gold Shimmer Auto /50"
  const regex = /(?<year>\d{4})?\s*(?<brand>Bowman|Topps)?\s*(?<product>Chrome|Draft)?\s*(?<playerName>[A-Za-z\s]+)?\s*(?<parallel>[A-Za-z]+)?\s*(Auto)?\s*(\/\d+)?/i;
  const match = title.match(regex);
  if (!match || !match.groups) return null;
  const {
    year = null,
    brand = null,
    product = null,
    playerName = null,
    parallel = null
  } = match.groups;
  // Find parallel bucket
  let parallelBucket = null;
  if (parallel) {
    parallelBucket = parallels.find(p => parallel.toLowerCase().includes(p.displayName.split(' ')[0].toLowerCase()));
  }
  return {
    playerName: playerName ? playerName.trim() : null,
    year: year ? parseInt(year) : null,
    brand: brand || null,
    product: product || null,
    setType: null,
    cardType: 'Auto',
    autoFlag: true,
    serial: null,
    parallel: parallel || null,
    parallelBucket: parallelBucket ? parallelBucket.canonicalName : null,
    is1stBowman: title.toLowerCase().includes('1st bowman'),
    grade: null,
    normalizedKey: [year, brand, product, playerName, parallelBucket ? parallelBucket.canonicalName : parallel].filter(Boolean).join('-')
  };
}

module.exports = { normalizeCardTitle };

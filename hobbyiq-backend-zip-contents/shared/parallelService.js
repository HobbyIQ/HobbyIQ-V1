// parallelService.js - Parallel bucketing and lookup
const parallels = require('../config/parallels');

function getParallelByName(name) {
  return parallels.find(p => p.displayName.toLowerCase() === name.toLowerCase() || p.canonicalName === name);
}

function getAdjacentParallels(canonicalName) {
  const p = parallels.find(p => p.canonicalName === canonicalName);
  return p ? p.adjacency : [];
}

function getAllParallels() {
  return parallels;
}

module.exports = { getParallelByName, getAdjacentParallels, getAllParallels };

// compRepository.js - Mock/local comp persistence
const path = require('path');
const fs = require('fs');
const compsFile = __dirname + '/../test-data/sampleComps.js';

function getAllComps() {
  // For now, just load mock comps
  // Use forward slashes for Linux compatibility
  return require(compsFile.replace(/\\/g, '/'));
}

function saveComp(comp) {
  // No-op for mock
  return true;
}

module.exports = { getAllComps, saveComp };

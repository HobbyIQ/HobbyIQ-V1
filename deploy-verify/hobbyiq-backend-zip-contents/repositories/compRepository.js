// compRepository.js - Mock/local comp persistence
const path = require('path');
const fs = require('fs');
const compsFile = path.join(__dirname, '../test-data/sampleComps.js');

function getAllComps() {
  // For now, just load mock comps
  return require(compsFile);
}

function saveComp(comp) {
  // No-op for mock
  return true;
}

module.exports = { getAllComps, saveComp };

// pricingRepository.js - Mock/local pricing result persistence
const results = [];
function savePricingResult(result) {
  results.push(result);
  return true;
}
function getAllPricingResults() {
  return results;
}
module.exports = { savePricingResult, getAllPricingResults };

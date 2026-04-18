// marketSummary.js - Market intelligence summary model
module.exports = {
  trendDirection: String,
  trendStrength: Number,
  estimatedLiquidity: String,
  supplySummary: {
    availableCount: Number,
    direction2Week: String,
    direction4Week: String,
    direction3Month: String
  },
  marketLadder: Array
};

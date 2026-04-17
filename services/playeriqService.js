exports.analyzePlayeriq = async (input) => {
  const player = input.player || '';
  return {
    success: true,
    player,
    playerSummary: "High-upside prospect with strong market interest.",
    talentScore: 82,
    marketScore: 77,
    overallScore: 80,
    recommendation: "BUY/HOLD",
    buyZones: {
      baseAuto: [100, 130],
      refractor: [140, 180],
      blue: [250, 325]
    },
    sellZones: {
      baseAuto: [180, 230],
      refractor: [240, 315],
      blue: [400, 525]
    },
    topParallelsToBuy: [
      { name: "Refractor", reason: "Strong liquidity" },
      { name: "Blue", reason: "Healthy premium vs base" }
    ],
    marketLadder: [],
    recentComps: [],
    confidence: 0.75,
    source: "mock"
  };
};

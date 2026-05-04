// Legacy/mock CompIQ analysis for /price, /search, /analyze only. Not used for /estimate.
async function analyzeCompiq(input: any) {
  const player = input.player || '';
  const card = input.card || '';
  return {
    success: true,
    query: `${player} ${card}`.trim(),
    summary: "Market is active with strong demand.",
    marketTier: { entry: 120, fair: 155, premium: 210 },
    buyZone: [110, 135],
    holdZone: [136, 180],
    sellZone: [181, 240],
    recentComps: [],
    supply: {
      activeListings: null,
      trend2w: null,
      trend4w: null,
      trend3m: null
    },
    confidence: 0.72,
    source: "mock"
  };
}

export { analyzeCompiq };

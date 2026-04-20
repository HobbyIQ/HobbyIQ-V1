exports.analyzeCompiq = async (input) => {
  // Accepts: player, cardType, parallel, grade, recentComps
  // All fields optional for now, but should be validated upstream
  return {
    title: "CompIQ",
    summaryLine: "Raw speckle /299: ~$200 – $260",
    priceLanes: {
      lowEnd: "$180–$200",
      fairMarket: "$220–$250",
      ceiling: "$275+ if hot"
    },
    hobbyIQZones: {
      buyZone: "<$220",
      fair: "$220–$250",
      stretch: "$260+",
      sellZone: "$260–$300"
    },
    whatWeKnow: [
      "Base auto PSA 10: $288",
      "Speckle /299 PSA 10 comps: ~$421 recent average",
      "Listings around $600 range (not sold)",
      "Raw speckle sales: ~$170–$225 recent comps"
    ],
    compBreakdown: [
      "Using your base PSA 10 = $288",
      "Step 1 — convert to speckle PSA 10",
      "288 × 1.5–1.7 = $430–$490",
      "aligns with real comps around ~$421"
    ]
  };
};

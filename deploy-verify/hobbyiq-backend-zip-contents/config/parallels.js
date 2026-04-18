// parallels.js - Parallel tier config for HobbyIQ Pricing Engine Phase 1
module.exports = [
  {
    displayName: "Base Auto",
    canonicalName: "base_auto",
    serialPrintRun: null,
    rarityTier: 1,
    bucketGroup: "base",
    adjacency: ["refractor_499"],
    relativeStrength: 1.0,
    confidenceWeight: 1.0
  },
  {
    displayName: "Refractor /499",
    canonicalName: "refractor_499",
    serialPrintRun: 499,
    rarityTier: 2,
    bucketGroup: "refractor",
    adjacency: ["base_auto", "speckle_299"],
    relativeStrength: 1.15,
    confidenceWeight: 0.95
  },
  {
    displayName: "Speckle /299",
    canonicalName: "speckle_299",
    serialPrintRun: 299,
    rarityTier: 3,
    bucketGroup: "speckle",
    adjacency: ["refractor_499", "purple_250"],
    relativeStrength: 1.22,
    confidenceWeight: 0.93
  },
  {
    displayName: "Purple /250",
    canonicalName: "purple_250",
    serialPrintRun: 250,
    rarityTier: 4,
    bucketGroup: "purple",
    adjacency: ["speckle_299", "aqua_199"],
    relativeStrength: 1.28,
    confidenceWeight: 0.92
  },
  {
    displayName: "Aqua /199",
    canonicalName: "aqua_199",
    serialPrintRun: 199,
    rarityTier: 5,
    bucketGroup: "aqua",
    adjacency: ["purple_250", "blue_150"],
    relativeStrength: 1.33,
    confidenceWeight: 0.91
  },
  {
    displayName: "Blue /150",
    canonicalName: "blue_150",
    serialPrintRun: 150,
    rarityTier: 6,
    bucketGroup: "blue",
    adjacency: ["aqua_199", "green_99"],
    relativeStrength: 1.4,
    confidenceWeight: 0.90
  },
  {
    displayName: "Green /99",
    canonicalName: "green_99",
    serialPrintRun: 99,
    rarityTier: 7,
    bucketGroup: "green",
    adjacency: ["blue_150", "yellow_75"],
    relativeStrength: 1.5,
    confidenceWeight: 0.89
  },
  {
    displayName: "Yellow /75",
    canonicalName: "yellow_75",
    serialPrintRun: 75,
    rarityTier: 8,
    bucketGroup: "yellow",
    adjacency: ["green_99", "gold_50"],
    relativeStrength: 1.6,
    confidenceWeight: 0.88
  },
  {
    displayName: "Gold /50",
    canonicalName: "gold_50",
    serialPrintRun: 50,
    rarityTier: 9,
    bucketGroup: "gold",
    adjacency: ["yellow_75", "orange_25"],
    relativeStrength: 1.8,
    confidenceWeight: 0.87
  },
  {
    displayName: "Orange /25",
    canonicalName: "orange_25",
    serialPrintRun: 25,
    rarityTier: 10,
    bucketGroup: "orange",
    adjacency: ["gold_50", "red_5"],
    relativeStrength: 2.2,
    confidenceWeight: 0.85
  },
  {
    displayName: "Red /5",
    canonicalName: "red_5",
    serialPrintRun: 5,
    rarityTier: 11,
    bucketGroup: "red",
    adjacency: ["orange_25", "superfractor_1"],
    relativeStrength: 3.0,
    confidenceWeight: 0.80
  },
  {
    displayName: "Superfractor 1/1",
    canonicalName: "superfractor_1",
    serialPrintRun: 1,
    rarityTier: 12,
    bucketGroup: "superfractor",
    adjacency: ["red_5"],
    relativeStrength: 5.0,
    confidenceWeight: 0.60
  }
];

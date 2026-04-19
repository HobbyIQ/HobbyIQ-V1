"use strict";
// Example CompIQ sample data for development and testing
Object.defineProperty(exports, "__esModule", { value: true });
exports.sampleCompIQResponses = exports.sampleCompIQRequests = void 0;
exports.sampleCompIQRequests = [
    {
        query: "LeBron James 2019 Prizm Silver PSA 10 Auto"
    },
    {
        query: "Shohei Ohtani 2018 Topps Chrome Gold",
        player: "Shohei Ohtani",
        set: "2018 Topps Chrome",
        parallel: "Gold"
    },
    {
        query: "Julio Rodriguez 2022 Bowman Base"
    }
];
exports.sampleCompIQResponses = [
    {
        success: true,
        player: "LeBron James",
        cardSet: "2019 Prizm",
        productFamily: "Prizm",
        parallel: "Silver",
        normalizedParallel: "silver",
        isAuto: true,
        cardType: "Auto",
        rawPrice: 120,
        adjustedRaw: 114,
        estimatedPsa9: 252,
        estimatedPsa10: 420,
        confidenceScore: 90,
        confidenceLabel: "High",
        explanation: "Estimated value for LeBron James 2019 Prizm Silver...",
        warnings: [],
        nextActions: ["View comps", "Estimate grading ROI"]
    }
];

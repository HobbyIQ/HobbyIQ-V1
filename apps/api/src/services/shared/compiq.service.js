"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompIQService = void 0;
const compiq_utils_1 = require("../../utils/compiq-utils");
class CompIQService {
    constructor(compProvider) {
        this.compProvider = compProvider;
    }
    async query(input) {
        // Use mock provider for now
        const comps = await this.compProvider.getComps(input);
        return this.estimate({ ...input, recentComps: comps });
    }
    async estimate(input) {
        // Parallel normalization
        const normalizedParallel = (0, compiq_utils_1.normalizeParallel)(input.parallel);
        // Estimate pricing
        const { estimatedRaw, estimatedPsa10, estimatedPsa9, estimatedPsa8, fairMarketValue, compRangeLow, compRangeHigh, buyTarget } = this.compProvider.estimatePricing(input);
        // Market ladder
        const marketLadder = (0, compiq_utils_1.buildMarketLadder)(input, this.compProvider);
        // Confidence
        const confidenceScore = (0, compiq_utils_1.scoreConfidence)(input);
        // Supply analysis
        const supplyAnalysis = (0, compiq_utils_1.interpretSupply)(input.activeSupply);
        // Pricing signals
        const pricingSignals = this.compProvider.getPricingSignals(input, fairMarketValue);
        // Plain English bullets
        const plainEnglishBullets = this.compProvider.getBullets(input, fairMarketValue);
        // Next actions
        const nextActions = this.compProvider.getNextActions(input, fairMarketValue);
        return {
            success: true,
            title: `${input.player} ${input.cardSet || ''} ${input.year || ''}`.trim(),
            summary: `${input.player} ${input.cardSet || ''} ${input.year || ''}`.trim(),
            ...input,
            normalizedParallel,
            estimatedRaw,
            estimatedPsa10,
            estimatedPsa9,
            estimatedPsa8,
            fairMarketValue,
            compRangeLow,
            compRangeHigh,
            buyTarget,
            confidenceScore,
            compCount: input.recentComps?.length || 0,
            recentComps: input.recentComps || [],
            marketLadder,
            supplyAnalysis,
            pricingSignals,
            plainEnglishBullets,
            nextActions,
        };
    }
}
exports.CompIQService = CompIQService;

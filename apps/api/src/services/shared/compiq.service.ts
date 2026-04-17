import { CompIQInput, CompIQOutput } from '../../domain/compiq/compiq.types';
import { CompProvider } from '../mock/mock-comp-provider';
import { normalizeParallel, buildMarketLadder, scoreConfidence, interpretSupply } from '../../utils/compiq-utils';

export class CompIQService {
  constructor(private compProvider: CompProvider) {}

  async query(input: CompIQInput): Promise<CompIQOutput> {
    // Use mock provider for now
    const comps = await this.compProvider.getComps(input);
    return this.estimate({ ...input, recentComps: comps });
  }

  async estimate(input: CompIQInput): Promise<CompIQOutput> {
    // Parallel normalization
    const normalizedParallel = normalizeParallel(input.parallel);
    // Estimate pricing
    const { estimatedRaw, estimatedPsa10, estimatedPsa9, estimatedPsa8, fairMarketValue, compRangeLow, compRangeHigh, buyTarget } = this.compProvider.estimatePricing(input);
    // Market ladder
    const marketLadder = buildMarketLadder(input, this.compProvider);
    // Confidence
    const confidenceScore = scoreConfidence(input);
    // Supply analysis
    const supplyAnalysis = interpretSupply(input.activeSupply);
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

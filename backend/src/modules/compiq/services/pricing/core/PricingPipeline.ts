
import { CardIdentityEngine } from '../identity/CardIdentityEngine.js';
import { CompDedupeEngine } from '../comps/CompDedupeEngine.js';
import { CompProvenanceEngine } from '../comps/CompProvenanceEngine.js';
import { AuctionIntelligenceEngine } from '../comps/AuctionIntelligenceEngine.js';
import { MarketEfficiencyEngine } from '../market/MarketEfficiencyEngine.js';
import { LiquidityDepthEngine } from '../market/LiquidityDepthEngine.js';
import { PriceDistributionEngine } from '../value/PriceDistributionEngine.js';
import { DealScoreEngine } from '../value/DealScoreEngine.js';
import { ROIProjectionEngine } from '../value/ROIProjectionEngine.js';
import { ExitStrategyEngine } from '../value/ExitStrategyEngine.js';
import { MarketDNAEngine } from '../market/MarketDNAEngine.js';
import { FeeNetValueEngine } from '../value/FeeNetValueEngine.js';
import { ScenarioEngine } from '../value/ScenarioEngine.js';
import { ConfidenceEngine } from '../intelligence/ConfidenceEngine.js';
import { ExplainabilityEngine } from '../intelligence/ExplainabilityEngine.js';
import { AlertSignalEngine } from '../intelligence/AlertSignalEngine.js';
import { PriceTrendProjector } from '../intelligence/PriceTrendProjector.js';
import { clampScore } from '../utils/pricing.utils.js';
import { VerdictEngine } from '../../verdict/VerdictEngine.js';
import { ExplanationEngine } from '../../verdict/ExplanationEngine.js';
import { MarketDNAEngine as SimpleMarketDNAEngine } from '../../verdict/MarketDNAEngine.js';

export class PricingPipeline {
  static process(subject: any, comps: any, context: any, debug = false) {
    // 1. Card identity
    const identity = CardIdentityEngine.normalize(subject);

    // 2. Dedupe comps
    const dedupedComps = CompDedupeEngine.dedupe(comps);

    // 3. Score provenance/trust and auction quality
    const scoredComps = dedupedComps.map((comp: any) => {
      const trust = CompProvenanceEngine.score(comp);
      const auction = AuctionIntelligenceEngine.score(comp);
      const daysOnMarket = MarketEfficiencyEngine.daysOnMarket(comp);
      const timeToSellScore = MarketEfficiencyEngine.timeToSellScore(daysOnMarket);
      return {
        ...comp,
        trust,
        auction,
        daysOnMarket,
        timeToSellScore
      };
    });

    // 4. Compute trend-aware FMV
    // Sort comps by date (oldest → newest). Comps without a date goes to the end.
    const datedComps = [...scoredComps].sort((a: any, b: any) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return da - db;
    });

    // Parallel scarcity normalization
    // When a specific parallel is requested, normalize EVERY comp price to the target
    // print run using a power-law: price ∝ (1/printRun)^0.5
    //   e.g. SuperFractor 1/1 @ $10k → Blue /99 equivalent ≈ $10k × (1/99)^0.5 ≈ $1,005
    // This means higher-rarity comps inform the Blue value instead of being discarded.
    // When no parallel is specified (base card), use IQR outlier removal instead
    // (the serial filter in the estimate service already stripped numbered comps).
    const PARALLEL_PRINT_RUNS: Record<string, number> = {
      superfractor: 1, 'super fractor': 1,
      red: 5, orange: 25, gold: 50,
      blue: 99, green: 99, purple: 250,
    };
    // 0.50 is the standard power-law exponent for scarcity pricing.
    // Lower values over-inflate rare comp normalizations (e.g. a $37k SF normalized to Blue /99
    // gives ~$3.7k at 0.50 but ~$8.7k at 0.30 — causing FMV spikes when high-rarity comps
    // appear in the pool).  Keep at 0.50.
    const SCARCITY_EXPONENT = 0.50;

    const extractCompPrintRun = (title: string): number | null => {
      if (/super\s*fractor/i.test(title)) return 1;
      const m = title.match(/(?:#\s*\/|(?<!\d)\/)\s*(\d{1,4})(?:\b|$)/i);
      return m ? parseInt(m[1], 10) : null;
    };

    const parallelKey = (subject.parallel ?? '').toLowerCase().replace(/\s*refractor\s*/gi, '').trim();
    const targetPrintRun: number | null = PARALLEL_PRINT_RUNS[parallelKey] ?? null;

    let pricedComps = datedComps;
    if (targetPrintRun) {
      // Normalize all comp prices to the target parallel's print run.
      // Comps with no extractable print run (base cards, no serial in title) CANNOT be
      // placed on the same price plane — a base Bonemer at $40 is not a comp for a Blue /99
      // at $500+.  Drop them from the parallel pool; fall back to full set only if too few remain.
      const normalizedAll = datedComps.map((c: any) => {
        const compRun = extractCompPrintRun(c.title ?? '');
        if (compRun === null) return null; // can't normalize — exclude
        if (compRun === 1 && targetPrintRun > 1) return null; // SuperFractor 1/1 normalizes to extreme values — always exclude
        if (compRun === targetPrintRun) return c; // exact match — keep as-is
        // price × (compRun / targetRun)^0.5
        const normalizedPrice = Math.round(c.price * Math.pow(compRun / targetPrintRun, SCARCITY_EXPONENT));
        return { ...c, price: normalizedPrice };
      }).filter(Boolean) as any[];
      // Fall back to full (un-normalized) set only if filtering leaves too few comps
      pricedComps = normalizedAll.length >= 3 ? normalizedAll : datedComps;
    } else {
      // Base card: apply IQR outlier removal (numbered comps that slipped serial filter)
      const allPrices = datedComps.map((c: any) => c.price).filter((p: any) => typeof p === 'number' && p > 0);
      if (allPrices.length >= 4) {
        const ps = [...allPrices].sort((a, b) => a - b);
        const q1 = ps[Math.floor(ps.length * 0.25)];
        const q3 = ps[Math.floor(ps.length * 0.75)];
        const iqr = q3 - q1;
        const lo = q1 - 1.5 * iqr;
        const hi = q3 + 1.5 * iqr;
        const filtered = datedComps.filter((c: any) => c.price >= lo && c.price <= hi);
        if (filtered.length >= 3) pricedComps = filtered;
      }
    }

    const validPrices = pricedComps.map((c: any) => c.price).filter((p: any) => typeof p === 'number' && p > 0);

    // For trend detection and regression, only use exact-match comps (same print run as target).
    // Mixed-parallel comps normalized to the same plane will have artificial chronological
    // price variation (a Gold /50 from 2 months ago normalizes higher than a recent Blue /99)
    // that creates false trend signals.  When no targetPrintRun, use the full pool.
    const exactMatchComps = targetPrintRun
      ? pricedComps.filter((c: any) => {
          const compRun = extractCompPrintRun(c.title ?? '');
          return compRun === targetPrintRun;
        })
      : pricedComps;
    const trendPrices = exactMatchComps.length >= 3
      ? exactMatchComps.map((c: any) => c.price).filter((p: any) => typeof p === 'number' && p > 0)
      : validPrices; // fall back to full pool if not enough exact matches

    let fairMarketValue = 0;
    let detectedTrend: 'up' | 'flat' | 'down' = 'flat';

    if (validPrices.length > 0) {
      const sorted = [...validPrices].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

      // Detect trend using regression slope on exact-match comps.
      // Positive slope = up, negative slope = down
      const earlyProjection = PriceTrendProjector.project(trendPrices);
      if (earlyProjection) {
        if (earlyProjection.slope > 10) detectedTrend = 'up';      // price rising
        else if (earlyProjection.slope < -10) detectedTrend = 'down'; // price falling
        // R² guard: only suppress Up/Down if fit is truly terrible (R² < 0.15).
        if (earlyProjection.rSquared < 0.15 && detectedTrend !== 'flat') {
          detectedTrend = 'flat';
        }
      }

      // Base FMV: use recency-weighted average (exp decay, newest = highest weight).
      // This ensures a card that has been rising from $300 → $600 in recent sales
      // starts from a base close to $600, not the historical median of $450.
      // Weight[i] = exp(i / n * 4) so the newest comp weighs ~e^4 ≈ 55× the oldest.
      const chronoPrices = pricedComps
        .map((c: any) => c.price)
        .filter((p: any) => typeof p === 'number' && p > 0);
      const rcn = chronoPrices.length;
      const recencyWeightedAvg = rcn > 0
        ? (() => {
            const ws = chronoPrices.map((_: number, i: number) => Math.exp((i / rcn) * 4));
            const tw = ws.reduce((s: number, w: number) => s + w, 0);
            return ws.reduce((s: number, w: number, i: number) => s + w * chronoPrices[i], 0) / tw;
          })()
        : median;

      const p75 = sorted[Math.floor(sorted.length * 0.75)];
      const p25 = sorted[Math.floor(sorted.length * 0.25)];

      // If the last 3+ sales are strictly ascending (each higher than the previous),
      // the card is in a clear uptrend — use the most recent sale directly, no averaging.
      const recentPrices = trendPrices.slice(-Math.min(trendPrices.length, 5)); // last 5 max
      const isStrictlyAscending = recentPrices.length >= 3
        && recentPrices.every((p, i) => i === 0 || p > recentPrices[i - 1]);
      if (isStrictlyAscending) {
        detectedTrend = 'up';
        fairMarketValue = recentPrices[recentPrices.length - 1]; // most recent sale is the market
      } else if (detectedTrend === 'up') {
        // Rising but not strictly ascending — use recency-weighted avg, no historical anchor
        fairMarketValue = recencyWeightedAvg;
      } else if (detectedTrend === 'down') {
        // Price is softening — median as anchor
        fairMarketValue = median;
      } else {
        // Flat: 70% recency + 30% median
        fairMarketValue = recencyWeightedAvg * 0.7 + median * 0.3;
      }
    }
    fairMarketValue = Math.round(fairMarketValue);
    // Safety: if FMV is 0 but we had comps, something went wrong—fall back to median
    if (fairMarketValue === 0 && (validPrices?.length ?? 0) > 0) {
      const sorted = [...validPrices].sort((a, b) => a - b);
      fairMarketValue = Math.round(sorted[Math.floor(sorted.length / 2)]);
    }

    // Market momentum multiplier — holistic demand+supply+trend signal
    // absorptionRate > 1.5 = more sales than active listings → strong demand (buyer's market)
    // absorptionRate < 0.5 = supply glut, weak demand (seller's market)
    // Combine with trend direction to decide whether FMV should be above or below comp average.
    //   e.g. high demand + rising → buyers competing, price has upward momentum → +15%
    //        supply glut + falling → sellers undercutting, card approaches floor price → -15%
    const momentumAbsorptionRate = context.soldCount30d / Math.max(1, context.activeListings);
    const demandStrong = momentumAbsorptionRate > 1.5;
    const demandWeak   = momentumAbsorptionRate < 0.5;

    // Momentum multiplier is intentionally small (±8% max) because the trend-aware
    // FMV blend (median→p75 for up, median→p25 for down) already accounts for direction.
    // This just nudges the final number based on supply/demand pressure.
    let momentumMultiplier = 1.0;
    if (demandStrong && detectedTrend === 'up')        momentumMultiplier = 1.08; // buyers competing + rising
    else if (demandStrong && detectedTrend === 'flat') momentumMultiplier = 1.03; // strong demand, stable
    else if (demandStrong && detectedTrend === 'down') momentumMultiplier = 0.97; // demand fading
    else if (!demandStrong && !demandWeak && detectedTrend === 'up')   momentumMultiplier = 1.04; // balanced + rising
    else if (!demandStrong && !demandWeak && detectedTrend === 'down') momentumMultiplier = 0.96; // balanced + cooling
    else if (demandWeak && detectedTrend === 'up')   momentumMultiplier = 1.0;  // rising despite weak demand — hold
    else if (demandWeak && detectedTrend === 'flat') momentumMultiplier = 0.95; // supply glut, liquid floor
    else if (demandWeak && detectedTrend === 'down') momentumMultiplier = 0.90; // oversupply + declining

    fairMarketValue = Math.round(fairMarketValue * momentumMultiplier);

    // Price trajectory projection — "what should the next sale be?"
    // Fit a weighted least-squares line through the chronological comp prices and
    // project one step ahead.  Blend the projection into FMV weighted by R²:
    //   R²=0.9 (near-perfect trend) → 90% projection, 10% comp-pool FMV
    //   R²=0.4 (scattered)          → 40% projection, 60% comp-pool FMV
    // This means a clean rising trend line drives the estimate, while noisy markets
    // fall back to the comp-pool anchor.
    const trendProjection = PriceTrendProjector.project(trendPrices);
    if (trendProjection && trendProjection.projectedPrice > 0) {
      // Blend the regression projection into FMV weighted by R².
      // No hard cap — the recency-weighted base FMV already reflects recent prices,
      // and the R²-based blend naturally dampens noisy projections:
      //   R²=0.9 → 90% projection weight (near-perfect trend line drives FMV)
      //   R²=0.4 → 40% projection weight (scattered comps, fallback to comp average)
      //   R²=0.1 → 10% projection weight (noise — projection barely moves FMV)
      // Only guard: prevent projection from going below zero or above 10× FMV.
      const safeProjection = Math.max(1, Math.min(fairMarketValue * 10, trendProjection.projectedPrice));
      const blendWeight = trendProjection.rSquared; // 0–1
      fairMarketValue = Math.round(
        safeProjection * blendWeight +
        fairMarketValue * (1 - blendWeight)
      );
      // Expose projection data for transparency / future analytics
      context.trendProjection = {
        projectedPrice: trendProjection.projectedPrice, // raw (uncapped) for display
        rSquared: Math.round(trendProjection.rSquared * 100) / 100,
        slope: Math.round(trendProjection.slope * 100) / 100,
        confidence: trendProjection.confidence,
      };
    }

    // Feed detected trend back into context so MarketDNA reflects real data
    context.rankingTrend = detectedTrend;
    // Debug: expose pool sizes so callers can see how many comps are exact-match vs cross-parallel
    context.compPoolDebug = {
      totalNormalized: validPrices.length,
      exactMatchForTrend: trendPrices.length,
      usingFallbackPool: exactMatchComps.length < 3,
    };

    // 5. Price lanes
    const marketSpeed = LiquidityDepthEngine.marketSpeed(context.avgDaysToSell);
    const quickSaleValue = PriceDistributionEngine.quickSale(fairMarketValue);
    const premiumValue = PriceDistributionEngine.premium(fairMarketValue, marketSpeed);

    // 6. Liquidity/market context
    const absorptionRate = LiquidityDepthEngine.absorptionRate(context.soldCount30d, context.activeListings);
    const marketPressure = LiquidityDepthEngine.marketPressure(absorptionRate);

    // 7. Confidence
    const compStrength = scoredComps.reduce((sum: any, c: any) => sum + (c.trust || 0), 0) / (scoredComps.length || 1);
    const liquidityScore = clampScore(absorptionRate * 100);
    const volatility = context.volatilityIndex || 50;
    const confidence = ConfidenceEngine.bundle(scoredComps.length, compStrength, liquidityScore, volatility);

    // 8. Deal score
    // pricingConfidence (0-100) represents market quality — use it as the edge signal.
    // This avoids passing raw dollar amounts (fairMarketValue) into a 0-100 formula.
    const dealEdge = confidence.pricingConfidence;
    let dealScore = DealScoreEngine.score(dealEdge, liquidityScore, confidence.timingConfidence, volatility);

    // Apply trend momentum: uptrending market pushes toward Buy, downtrending toward Sell/Pass.
    // +18 is enough to push a baseline Hold (66) into Buy territory (>=75).
    if (detectedTrend === 'up') dealScore = Math.min(100, dealScore + 18);
    else if (detectedTrend === 'down') dealScore = Math.max(0, dealScore - 18);

    let testArbitrageSignal = 'fair';

    // 9. ROI
    const roi = ROIProjectionEngine.project(confidence.timingConfidence, context.rankingTrend || 'flat', volatility);

    // 10. Exit strategy
    const exitStrategy = ExitStrategyEngine.recommend(liquidityScore, marketSpeed);

    // 11. Market DNA
    const marketDNA = MarketDNAEngine.classify(compStrength, liquidityScore, volatility, context.rankingTrend || 'flat');

    // 12. Alerts
    const alerts = AlertSignalEngine.generate(marketSpeed, marketPressure, dealScore);

    // 13. Explanation
    const explanation = ExplainabilityEngine.explain(
      scoredComps.map((c: any) => c.id || ''),
      [],
      { liquidity: liquidityScore, volatility, compStrength }
    );

    // 14. Fallback for empty comps
    if (!comps.length || fairMarketValue === 0) {
      return {
        subject,
        priceLanes: {
          quickSaleValue: 0,
          fairMarketValue: 0,
          premiumValue: 0,
        },
        netValueLanes: {
          grossQuickSaleValue: 0,
          grossFairMarketValue: 0,
          grossPremiumValue: 0,
          netQuickSaleValue: 0,
          netFairMarketValue: 0,
          netPremiumValue: 0,
        },
        scenarioValues: {
          bearCaseValue: 0,
          baseCaseValue: 0,
          bullCaseValue: 0,
          rationale: ['No comps available'],
        },
        dealScore: 0,
        roi: { roi30d: 0, roi90d: 0, roi6m: 0 },
        market: {
          marketSpeed: 'normal',
          marketPressure: 'balanced',
          absorptionRate: null,
          avgDaysToSell: null,
          marketRegime: 'neutral',
        },
        confidence: { pricingConfidence: 0, liquidityConfidence: 0, timingConfidence: 0 },
        arbitrage: {
          signal: 'fair',
          mispricingDeltaPct: 0,
        },
        exitStrategy: {
          recommendedMethod: 'bin',
          expectedDaysToSell: null,
          timingRecommendation: 'hold',
          reasoning: ['No comps available'],
        },
        marketDNA: { demand: 'low', liquidity: 'low', risk: 'high', trend: 'flat', volatility: 'medium' },
        alerts: ['No comps found, fallback estimate'],
        explanation: ['Insufficient data for pricing'],
        compSummary: [],
        explainability: {
          acceptedCompIds: [],
          rejectedCompIds: [],
          multiplierRationale: {},
          confidenceDrivers: [],
          pricingDrivers: [],
        },
        observability: {
          usedFallback: true,
          fallbackReason: 'Sparse or not enough sales',
          rejectedCompCount: 0,
          duplicateCompCount: 0,
          sparseDataFlag: true,
          anomalyFlags: [],
        },
        verdict: null,
        action: null,
        explanationBullets: [],
        simpleMarketDNA: null,
        success: false,
        error: 'No comps available',
        debug: debug ? { comps, context } : undefined,
      };
    }


    // Compose market and arbitrage objects for downstream consumers
    const market = {
      marketSpeed,
      marketPressure,
      absorptionRate,
      avgDaysToSell: context.avgDaysToSell ?? null,
      marketRegime: 'neutral',
    };
    const arbitrage = {
      signal: testArbitrageSignal,
      mispricingDeltaPct: 0,
    };

    // Verdict, action, explanation, marketDNA labels
    const { verdict, action } = VerdictEngine.generate({
      dealScore,
      priceLanes: { quickSaleValue, fairMarketValue, premiumValue },
      market,
      arbitrage,
      confidence,
      marketDNA,
    } as any, undefined);
    const explanationBullets = ExplanationEngine.generate({
      dealScore,
      priceLanes: { quickSaleValue, fairMarketValue, premiumValue },
      market,
      marketDNA,
      confidence,
      alerts,
      compSummary: scoredComps.map((c: any) => c.id || ''),
    } as any, undefined);
    const simpleMarketDNA = SimpleMarketDNAEngine.generate({ marketDNA } as any);

    return {
      subject,
      priceLanes: {
        quickSaleValue,
        fairMarketValue,
        premiumValue,
      },
      netValueLanes: {
        grossQuickSaleValue: quickSaleValue,
        grossFairMarketValue: fairMarketValue,
        grossPremiumValue: premiumValue,
        netQuickSaleValue: quickSaleValue,
        netFairMarketValue: fairMarketValue,
        netPremiumValue: premiumValue,
      },
      scenarioValues: {
        bearCaseValue: Math.round(fairMarketValue * 0.8),
        baseCaseValue: fairMarketValue,
        bullCaseValue: Math.round(fairMarketValue * 1.2),
        rationale: ['Auto-generated scenario values'],
      },
      dealScore,
      roi,
      market: {
        marketSpeed,
        marketPressure,
        absorptionRate,
        avgDaysToSell: context.avgDaysToSell ?? null,
        marketRegime: 'neutral',
      },
      confidence,
      arbitrage: {
        signal: 'fair',
        mispricingDeltaPct: 0,
      },
      exitStrategy,
      marketDNA: { ...marketDNA, volatility: context.volatilityIndex ? (context.volatilityIndex > 66 ? 'high' : context.volatilityIndex > 33 ? 'medium' : 'low') : 'medium' },
      alerts,
      explanation,
      compSummary: scoredComps.map((c: any) => c.id || ''),
      explainability: {
        acceptedCompIds: scoredComps.map((c: any) => c.id || ''),
        rejectedCompIds: [],
        multiplierRationale: {},
        confidenceDrivers: [],
        pricingDrivers: [],
      },
      observability: {
        usedFallback: false,
        rejectedCompCount: 0,
        duplicateCompCount: 0,
        sparseDataFlag: scoredComps.length < 3,
        anomalyFlags: [],
      },
      debug: debug ? { comps: scoredComps, context, identity } : undefined,
      // New outputs
      verdict,
      action,
      explanationBullets,
      simpleMarketDNA,
    };
  }
}

// ES module export


// --- In-memory cache for /api/search ---
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const searchCache = new Map();


import { classifyIntent } from './classifier';
import { SearchRequest, SearchResponse, PlayerIQService, CompIQService, BuySellDecisionService, CompareService } from './types';
import { extractPlayerOrCard, parseQuery } from '../utils/intentClassifier';
import { getPlayerPerformance } from '../services/playerPerformance';
import { fetchSoldListingsFromApify } from '../compiq/apify';
import { normalizeApifySoldRecords } from '../compiq/normalize';
import { calculateCompIQMarketStats } from '../compiq/service';
import { runDecisionEngine } from '../engines/decision/service';
import { runSellIQ } from '../engines/selliq/service';

// --- Integration points: inject real services here ---
// PlayerIQ now uses the real engine for playeriq intent
const playerIQService: PlayerIQService = {
  async getPlayerReport(player, query) {
    try {
      const perf = await getPlayerPerformance(player);
      if (!perf || !perf.stats) {
        return {
          title: `Player Evaluation: ${player}`,
          summary: `No detailed stats found for ${player}. Please check the player name or try another query.`,
          bullets: [
            `No stats available for this player.`,
            `Try a different player or spelling.`,
            `Check for recent call-ups or roster changes.`
          ],
          nextActions: [
            `Try another player name.`,
            `Check spelling or use full name.`,
            `Ask about a different player or card.`
          ],
          result: { playerId: player, found: false }
        };
      }
      // Transform real output to normalized response
      return {
        title: `Player Evaluation: ${player}`,
        summary: perf.notes || `Scouting report for ${player} based on latest performance data.`,
        bullets: [
          ...(perf.stats.points !== undefined ? [`Recent points: ${perf.stats.points}`] : []),
          ...(perf.stats.assists !== undefined ? [`Recent assists: ${perf.stats.assists}`] : []),
          ...(perf.stats.rebounds !== undefined ? [`Recent rebounds: ${perf.stats.rebounds}`] : []),
          `See advanced stats and splits for more details.`,
        ],
        nextActions: [
          `See advanced stats, splits, and news for ${player}.`,
          `Compare ${player} to similar prospects or MLB comps.`,
          `Ask for buy/sell/hold advice for ${player}.`
        ],
        result: { ...perf } as Record<string, unknown>
      };
    } catch (err) {
      return {
        title: `Player Evaluation: ${player}`,
        summary: `Could not fetch player data for ${player}.`,
        bullets: [
          `An error occurred while fetching player data.`,
          `Try again later or with a different player.`
        ],
        nextActions: [
          `Try another player name.`,
          `Check spelling or use full name.`,
          `Ask about a different player or card.`
        ],
        result: { playerId: player, found: false, error: true }
      };
    }
  }
};

// --- In-memory cache for CompIQ sold-data queries ---
const COMPIQ_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const compiqCache = new Map();

function getCompIQCacheKey(params: any) {
  // Normalize key: player|set|parallel|isAuto|serial
  return [
    (params.player || '').toLowerCase().trim(),
    (params.set || '').toLowerCase().trim(),
    (params.parallel || '').toLowerCase().trim(),
    params.isAuto ? 'auto' : '',
    (params.serial || '').toLowerCase().trim()
  ].join('|');
}

const compIQService: CompIQService = {
  async getCardComps(card, query, parsed) {
    try {
      const params = {
        player: parsed?.player || card,
        set: parsed?.set,
        parallel: parsed?.parallel,
        isAuto: parsed?.isAuto,
        serial: parsed?.serial,
        maxResults: 40
      };
      const cacheKey = getCompIQCacheKey(params);
      const now = Date.now();
      // Check cache
      const cached = compiqCache.get(cacheKey);
      if (cached && now < cached.expires) {
        return cached.data;
      }
      // Fetch and compute
      const comps = await getCompIQComps(params);
      // Handle dataset error
      if ((comps as any)._fetchError && (comps as any)._fetchErrorType === "DATASET_ERROR") {
        return {
          success: false,
          errorType: "DATASET_ERROR",
          message: "Apify dataset not found or not ready"
        };
      }
      // Handle fetch error
      if ((comps as any)._fetchError) {
        return {
          title: `Value Guidance: ${card}`,
          summary: `Could not fetch comp data for ${card}: ${(comps as any)._fetchErrorMessage}`,
          bullets: [
            `An error occurred while fetching comp data: ${(comps as any)._fetchErrorMessage}`,
            `Check your Apify credentials and dataset ID.`,
            `Try again later or with a different card.`
          ],
          nextActions: [
            `Try another card or add more details.`,
            `Check spelling, set, or parallel.`,
            `Ask about a different card or player.`
          ],
          result: { card, found: false, error: true }
        };
      }
      // Handle no comps
      if ((comps as any)._noComps) {
        return {
          success: true,
          compsFound: false,
          reason: (comps as any)._noCompsReason,
          suggestion: (comps as any)._noCompsSuggestion,
          data: []
        };
      }
      // Normalized/pricing output
      const pricing = (comps as any)._pricing || {};
      return {
        success: true,
        compsFound: true,
        median: pricing.median,
        range: pricing.range,
        compCount: pricing.compCount,
        confidence: pricing.confidence,
        comps: comps
      };
    } catch (err) {
      return {
        title: `Value Guidance: ${card}`,
        summary: `Could not fetch comp data for ${card}.`,
        bullets: [
          `An error occurred while fetching comp data.`,
          `Try again later or with a different card.`
        ],
        nextActions: [
          `Try another card or add more details.`,
          `Check spelling, set, or parallel.`,
          `Ask about a different card or player.`
        ],
        result: { card, found: false, error: true }
      };
    }
  }
};

const buySellDecisionService: BuySellDecisionService = {
  async getDecision(card, query) {
    try {
      // Minimal: run both engines, combine outputs
      // For demo, treat card as string; in real use, parse details
      const decInput = {
        compIQ: 70, // Placeholder, wire real compIQ if available
        playerIQ: 70, // Placeholder, wire real playerIQ if available
        dailyIQ: 65,
        supplyScore: 50,
        scarcityScore: 40,
        liquidityScore: 60,
        negativePressureScore: 10,
        pricingTrend: 10
      };
      const dec = runDecisionEngine(decInput);
      const sell = runSellIQ({
        currentFMV: 120,
        riskAdjustedFMV: 115,
        quickExitFMV: 110,
        compTrendPercent: 8,
        liquidityScore: 60,
        activeListingCount: 5,
        soldCountRecent: 3,
        cardTier: 'mid',
        marketMomentumScore: 12,
        urgencyScore: dec.urgencyScore,
        costBasis: 100,
        decisionRecommendation: dec.recommendation,
        negativePressureScore: decInput.negativePressureScore
      });
      return {
        title: `Buy/Sell/Hold Recommendation: ${card}`,
        summary: dec.explanation[0] || `Decision engine output for ${card}.`,
        bullets: [
          `Recommendation: ${dec.recommendation}`,
          `Confidence: ${dec.confidenceScore}/100`,
          `Urgency: ${dec.urgencyScore}/100`,
          ...(dec.explanation.slice(1)),
          ...(sell.reasoning || [])
        ],
        nextActions: [
          `Set a price alert or sell target for ${card}.`,
          `Review your portfolio exposure and diversification.`,
          `See supporting comps, player news, and expert opinions.`
        ],
        result: {
          recommendation: dec.recommendation,
          confidence: dec.confidenceScore,
          urgency: dec.urgencyScore,
          summary: dec.explanation[0],
          reasoning: dec.explanation,
          sellStrategy: sell,
        }
      };
    } catch (err) {
      return {
        title: `Buy/Sell/Hold Recommendation: ${card}`,
        summary: `Could not fetch decision or sell data for ${card}.`,
        bullets: [
          `An error occurred while fetching decision/sell data.`,
          `Try again later or with a different card.`
        ],
        nextActions: [
          `Try another card or add more details.`,
          `Check spelling, set, or parallel.`,
          `Ask about a different card or player.`
        ],
        result: { card, found: false, error: true }
      };
    }
  }
};

import { getComps } from '../services/comps';

const compareService: CompareService = {
  async getComparison(left, right, query) {
    try {
      // Fetch comps for both sides
      const [leftComps, rightComps] = await Promise.all([
        getComps(left),
        getComps(right)
      ]);

      // Helper to summarize comps
      function summarizeComps(comps: Array<{ price: number }>, label: string): string {
        if (!comps || comps.length === 0) return `${label}: No recent sales found.`;
        const prices = comps.map((c: { price: number }) => c.price);
        const avg = (prices.reduce((a: number, b: number) => a + b, 0) / prices.length).toFixed(2);
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        return `${label}: Avg $${avg} (Range $${min}-$${max}, ${comps.length} sales)`;
      }

      const leftSummary = summarizeComps(leftComps, left);
      const rightSummary = summarizeComps(rightComps, right);

      // Simple winner logic
      let winner = null;
      if (leftComps.length && rightComps.length) {
        const leftAvg = leftComps.reduce((a, b) => a + b.price, 0) / leftComps.length;
        const rightAvg = rightComps.reduce((a, b) => a + b.price, 0) / rightComps.length;
        if (leftAvg > rightAvg) winner = left;
        else if (rightAvg > leftAvg) winner = right;
      }

      return {
        title: `Comparison: ${left} vs ${right}`,
        summary: [leftSummary, rightSummary].join(' | '),
        bullets: [
          leftSummary,
          rightSummary,
          winner ? `Higher average value: ${winner}` : 'No clear value winner.',
          `Review liquidity, rarity, and collector demand for deeper insight.`
        ],
        nextActions: [
          `See detailed comp tables for both cards/parallels.`,
          `Ask for population, print run, or expert opinions.`,
          `Request buy/sell/hold advice for either option.`
        ],
        result: {
          left: { comps: leftComps },
          right: { comps: rightComps },
          winner
        }
      };
    } catch (err) {
      return {
        title: `Comparison: ${left} vs ${right}`,
        summary: `Could not fetch comp data for one or both options.`,
        bullets: [
          `An error occurred while fetching comparison data.`,
          `Try again later or with different cards/parallels.`
        ],
        nextActions: [
          `Try another comparison or add more details.`,
          `Check spelling, set, or parallel.`,
          `Ask about a different card or player.`
        ],
        result: { left, right, error: true }
      };
    }
  }
};

export async function handleSearch(req: SearchRequest): Promise<SearchResponse> {
  // Normalize query key
  const normKey = (req.query || '').trim().toLowerCase();
  const now = Date.now();
  // Bypass cache for clearly new queries (random, >100 chars, or contains 'test', 'debug', 'xxx')
  const bypass = normKey.length > 100 || /test|debug|xxx/.test(normKey);
  if (!bypass && searchCache.has(normKey)) {
    const { data, expires } = searchCache.get(normKey);
    if (now < expires) {
      return { ...data, _cache: 'hit' };
    } else {
      searchCache.delete(normKey);
    }
  }
  // Always parse the query and pass context
  const parsed = parseQuery(req.query);
  const intent: string = classifyIntent(req.query);
  const playerOrCard = parsed.player || extractPlayerOrCard(req.query);
  const q = req.query;

  // Detect vague/weak queries
  // Improved vague/unclear query detection
  const vaguePatterns = [
    /^(worth( it)?\??|value\??|should I|sell\??|buy\??|hold\??|compare|vs\.?|versus|how much|price\??|good\??|details\??|info\??|recommend\??|suggest\??|help\??)$/i,
    /^.{0,3}$/,
    /^[a-zA-Z0-9 ]{1,12}$/
  ];
  const isVague =
    !q.trim() ||
    vaguePatterns.some((pat) => pat.test(q.trim())) ||
    (!playerOrCard && ['playeriq', 'compiq', 'buy_sell_decision', 'general_card_analysis'].includes(intent));

  if (isVague) {
    // Try to give more specific guidance based on the query
    let summary = "Your question is a bit too short or unclear. Please add more details, like a player name, card, or what you want to know.";
    const lower = q.trim().toLowerCase();
    if (/^worth( it)?\??$/.test(lower)) {
      summary = "'Worth it?' is too vague. Try specifying the card, player, or set you want to know about.";
    } else if (/^[a-z]+$/.test(lower) && lower.length > 2) {
      summary = `"${q.trim()}" could be a player or card, but I need more details (e.g. set, parallel, or question).`;
    }
    return {
      success: true,
      query: req.query,
      intent: 'clarification',
      title: "Please clarify your question",
      summary,
      result: {},
      bullets: [
        "Try asking about a specific player or card (e.g. 'Is Brady Ebel a good prospect?').",
        "Include details like set, parallel, serial number, or grade for better results.",
        "You can also ask about value, comparisons, or buy/sell decisions.",
        "Example: 'What is a Roman Anthony gold shimmer /50 worth?'"
      ],
      nextActions: [
        "Rephrase your question with more details.",
        "Use one of the example prompts above.",
        "Ask about a player, card, or market trend.",
        "Include set, parallel, or serial number if possible."
      ]
    };
  }

  // --- Service boundaries for real data integration ---
  let response: any;
  switch (intent) {
    case 'playeriq': {
      const player = playerOrCard || 'this player';
      response = await playerIQService.getPlayerReport(player, q, parsed);
      break;
    }
    case 'compiq': {
      // Use real CompIQ sold-data pipeline
      const compResult = await compIQService.getCardComps(playerOrCard || 'this card', q);
      response = {
        ...compResult,
        // confidenceScore: compResult.result?.confidence, // Already included
      };
      break;
    }
    case 'compare': {
      const left = parsed.left || 'Option 1';
      const right = parsed.right || 'Option 2';
      response = await compareService.getComparison(left, right, q);
      break;
    }
    case 'buy_sell_decision': {
      const compResult = await compIQService.getCardComps(playerOrCard || 'this card', q);
      const decisionResult = await buySellDecisionService.getDecision(playerOrCard || 'this card', q);
      // Fallback: use confidenceScore from decisionResult if present, else 0
      response = {
        ...decisionResult,
        confidenceScore: (decisionResult as any).confidenceScore ?? 0,
        confidenceLabel: (decisionResult as any).confidenceLabel ?? '',
        confidenceExplanation: (decisionResult as any).confidenceExplanation ?? ''
      };
      break;
    }
    case 'general_card_analysis': {
      // Use real CompIQ sold-data pipeline for value, blend with other info as needed
      const compResult = await compIQService.getCardComps(playerOrCard || 'this card', q);
      response = {
        ...compResult,
        title: `Blended Card Analysis: ${playerOrCard || 'this card'}`,
        summary: `A quick blend of value, player outlook, and market context for ${playerOrCard || 'this card'}.\n${compResult.summary}`,
        bullets: [
          ...(compResult.bullets || []),
          `Player: Current performance, projection, and MLB outlook.`,
          `Market: Scarcity, population, and collector sentiment.`,
          `Comparison: How ${playerOrCard || 'this card'} stacks up to similar cards or players.`
        ],
        nextActions: [
          ...(compResult.nextActions || []),
          `Check grading population and print run reports.`
        ]
      };
      break;
    }
    default: {
      response = {
        success: false,
        query: req.query,
        intent,
        title: 'Sorry, I could not determine your intent.',
        summary: 'Please rephrase your question or ask about a player, card, or market.',
        result: {},
        bullets: [],
        nextActions: []
      };
      break;
    }
  }
  // Store in cache
  if (!bypass) {
    searchCache.set(normKey, { data: response, expires: now + SEARCH_CACHE_TTL_MS });
  }
  return { ...response, _cache: 'miss' };
}

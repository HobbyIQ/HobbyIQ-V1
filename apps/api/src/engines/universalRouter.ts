import type { UniversalSearchRequest, UniversalSearchIntent } from "../types/universal";
import { classifyIntent, parseQuery } from "../utils/intentClassifier";


import { compiqEngine } from "./compiq";
import { getPlayerPerformance } from "../services/playerPerformance";
import { runDecisionEngine } from "./decision/service";
import { runSellIQ } from "./selliq/service";

// Normalized response type
type NormalizedSearchResponse = {
  success: boolean;
  query: string;
  intent: string;
  title: string;
  summary: string;
  result: any;
  bullets: string[];
  nextActions: string[];
};

function toNormalizedResponse({
  query,
  intent,
  title = "",
  summary = "",
  result = {},
  bullets = [],
  nextActions = [],
  ...rest
}: Partial<NormalizedSearchResponse> & { query: string; intent: string }): NormalizedSearchResponse {
  return {
    success: true,
    query,
    intent,
    title,
    summary,
    result,
    bullets,
    nextActions,
    ...rest,
  };
}

  // Route to the correct engine and normalize
// Expanded intent type for routing
type ExpandedIntent = "comp" | "playeriq" | "compare" | "buy" | "sell" | "decision" | "general" | "unknown";

  const parsed = parseQuery(req.query);
  const intent = classifyIntent(req.query) as ExpandedIntent;

  if (intent === "comp") {
    // Route to CompIQ engine, pass parsed context
    const comp = await compiqEngine({ ...req, context: parsed });
    return toNormalizedResponse({
      query: req.query,
      intent: "compiq",
      title: "CompIQ Price Estimate",
      summary: comp.directAnswer || "Estimated value and recommendation.",
      result: comp,
      bullets: comp.why || [],
      nextActions: [comp.action || ""],
      parsed
    });
  } else if (intent === "playeriq") {
    // Route to real PlayerIQ (player performance), use parsed.player if available
    let player: any = null;
    let summary = "";
    let bullets: string[] = [];
    let action = "";
    try {
      const playerId = parsed.player || req.query.split(" ")[0];
      player = await getPlayerPerformance(playerId);
      summary = player && player.stats && player.stats.summary ? player.stats.summary : "Player analysis summary.";
      bullets = player && player.stats && player.stats.bullets ? player.stats.bullets : [];
      action = player && player.stats && player.stats.action ? player.stats.action : "Monitor for breakout.";
    } catch (e: any) {
      summary = "No player data available.";
      bullets = [e.message || "Player data unavailable."];
      action = "Try a different player.";
    }
    return toNormalizedResponse({
      query: req.query,
      intent: "playeriq",
      title: "PlayerIQ Analysis",
      summary,
      result: player,
      bullets,
      nextActions: [action],
      parsed
    });
  } else if (intent === "compare") {
    // Compare: fetch comp stats for left and right if possible
    let leftComp = null, rightComp = null;
    let leftSummary = "", rightSummary = "";
    if (parsed.left) {
      leftComp = await compiqEngine({ ...req, query: parsed.left });
      leftSummary = leftComp.directAnswer || "";
    }
    if (parsed.right) {
      rightComp = await compiqEngine({ ...req, query: parsed.right });
      rightSummary = rightComp.directAnswer || "";
    }
    const compare = {
      directAnswer: `Comparison complete.\nLeft: ${leftSummary}\nRight: ${rightSummary}`,
      why: [
        leftComp ? `Left FMV: $${leftComp.keyNumbers?.FMV ?? "?"}` : "No left comp data.",
        rightComp ? `Right FMV: $${rightComp.keyNumbers?.FMV ?? "?"}` : "No right comp data."
      ],
      action: "Review both options.",
      left: parsed.left,
      right: parsed.right,
      leftComp,
      rightComp,
      features: parsed
    };
    return toNormalizedResponse({
      query: req.query,
      intent: "compare",
      title: "Comparison Result",
      summary: compare.directAnswer || "Comparison summary.",
      result: compare,
      bullets: compare.why || [],
      nextActions: [compare.action || ""],
      parsed
    });
  } else if (intent === "buy" || intent === "sell" || intent === "decision") {
    // Route to Decision Engine + SellIQ, use parsed context if available
    let decisionResult: any = null;
    let sellResult: any = null;
    let summary = "";
    let bullets: string[] = [];
    let action = "";
    try {
      // Example: use parsed context to fill input, fallback to dummy values
      const input = {
        compIQ: 70,
        playerIQ: 65,
        dailyIQ: 60,
        supplyScore: 50,
        scarcityScore: 40,
        liquidityScore: 55,
        negativePressureScore: 20,
        pricingTrend: 0.1,
        ...parsed
      };
      decisionResult = runDecisionEngine(input);
      sellResult = runSellIQ({
        ...input,
        currentFMV: 100,
        riskAdjustedFMV: 95,
        quickExitFMV: 85,
        compTrendPercent: 5,
        activeListingCount: 10,
        soldCountRecent: 3,
        cardTier: "mid",
        marketMomentumScore: 10,
        urgencyScore: decisionResult.urgencyScore,
        costBasis: 80,
        decisionRecommendation: decisionResult.recommendation,
        negativePressureScore: input.negativePressureScore
      });
      summary = `Decision: ${decisionResult.recommendation}. Sell signal: ${sellResult.sellSignal}.`;
      bullets = [
        ...(decisionResult.explanation || []),
        ...(sellResult.reasoning || [])
      ];
      action = sellResult.expectedStrategy || "Review recommendation.";
    } catch (e: any) {
      summary = "No decision/sell data available.";
      bullets = [e.message || "Decision engine error."];
      action = "Try again later.";
    }
    return toNormalizedResponse({
      query: req.query,
      intent: intent,
      title: "Buy/Sell Decision",
      summary,
      result: { decisionResult, sellResult },
      bullets,
      nextActions: [action],
      parsed
    });
  } else if (intent === "general") {
    // General card analysis: use CompIQ for real sold data
    const comp = await compiqEngine(req);
    const general = {
      directAnswer: comp.directAnswer || "No FMV available.",
      why: comp.why || ["No comp data."],
      action: comp.action || "Hold for now.",
      keyNumbers: comp.keyNumbers,
      expandable: comp.expandable
    };
    return toNormalizedResponse({
      query: req.query,
      intent: "general",
      title: "General Card Analysis",
      summary: general.directAnswer || "General analysis summary.",
      result: general,
      bullets: general.why || [],
      nextActions: [general.action || ""]
    });
  } else {
    return toNormalizedResponse({
      query: req.query,
      intent: "unknown",
      title: "Unrecognized Query",
      summary: "Sorry, I couldn't understand your question.",
      result: {},
      bullets: ["No matching engine found for your query."],
      nextActions: ["Try rephrasing your search."]
    });
  }
}

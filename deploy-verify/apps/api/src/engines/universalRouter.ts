// Normalized response type for universalRouter
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
import type { UniversalSearchRequest, UniversalSearchIntent } from "../types/universal";
import { classifyIntent, parseQuery } from "../utils/intentClassifier";


import { compiqEngine } from "./compiq";
import { getPlayerPerformance } from "../services/playerPerformance";
import { runDecisionEngine } from "./decision/service";
import { runSellIQ } from "./selliq/service";

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

type ExpandedIntent = "comp" | "playeriq" | "compare" | "buy" | "sell" | "decision" | "general" | "unknown";

export async function universalRouter(req: UniversalSearchRequest): Promise<NormalizedSearchResponse> {
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
      nextActions: [comp.action || ""]
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
      nextActions: [action]
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
    return toNormalizedResponse({
      query: req.query,
      intent: "compare",
      title: "Comparison",
      summary: `${leftSummary} vs ${rightSummary}`,
      result: { left: leftComp, right: rightComp },
      bullets: [],
      nextActions: []
    });
  } else if (intent === "decision" || intent === "buy" || intent === "sell") {
    // Route to Decision Engine and/or SellIQ
    // Map UniversalSearchRequest to DecisionEngineInput (stub: use dummy values or extract from req/context)
    const context = req.context || {};
    const decisionInput = {
      compIQ: context.compIQ ?? 50,
      playerIQ: context.playerIQ ?? 50,
      dailyIQ: context.dailyIQ ?? 50,
      supplyScore: context.supplyScore ?? 50,
      scarcityScore: context.scarcityScore ?? 50,
      liquidityScore: context.liquidityScore ?? 50,
      negativePressureScore: context.negativePressureScore ?? 0,
      pricingTrend: context.pricingTrend ?? 0
    };
    const decisionResult = runDecisionEngine(decisionInput);
    const sellResult = runSellIQ({ ...context, decisionRecommendation: decisionResult.recommendation });
    const action = decisionResult.recommendation || (sellResult && sellResult.action) || "Hold";
    const bullets = decisionResult.explanation || ["No reason provided."];
    return toNormalizedResponse({
      query: req.query,
      intent,
      title: "Decision Engine",
      summary: decisionResult.recommendation,
      result: { decisionResult, sellResult },
      bullets,
      nextActions: [action]
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

export { universalRouter as routeUniversalSearch };

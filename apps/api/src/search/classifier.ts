
export type SearchIntent =
  | "playeriq"
  | "compiq"
  | "compare"
  | "buy_sell_decision"
  | "general_card_analysis";

export function classifyIntent(query: string): SearchIntent {
  const q = query.toLowerCase();
  // Compare intent: explicit compare, vs, versus, "better than", "difference between"
  if (/(compare|vs\.?|versus|better than|difference between|which is better|side by side)/.test(q)) return "compare";
  // Buy/sell/hold intent: explicit buy/sell/hold, "should I", "move on from", "keep or sell", "flip", "hold or sell", "worth selling"
  if (/(should i (buy|sell|hold)|buy or sell|move on from|keep or sell|time to (buy|sell|hold)|sell now|buy now|hold now|offload|dump|flip|move this|move him|move her|hold or sell|worth selling|worth buying|is it time to sell|is it time to buy|exit now|take profits|cut losses)/.test(q)) return "buy_sell_decision";
  // Player evaluation: "good prospect", "how is", "talent", "scout", "profile", "future", "upside", "call up", "MLB ready", "worth rostering", "compare to [player]", "MLB comp", "projection", "outlook", "ceiling", "floor", "tools", "hit tool", "power", "speed", "defense", "arm strength", "risk", "safe pick"
  if (/(good prospect|how is|talent|scout|profile|future|upside|call up|mlb ready|worth rostering|player evaluation|is [a-z ]+ good|how good|what kind of player|strengths|weaknesses|projection|outlook|ceiling|floor|tools|hit tool|power|speed|defense|arm strength|risk|safe pick|mlb comp|compare to [a-z ]+|mlb comparison|player comp|player comparison)/.test(q)) return "playeriq";
  // Card value/comps: "worth", "value", "comp", "comps", "price", "fmv", "shimmer", "refractor", "gold", "blue", "purple", "auto", "psa", "bgs", "sgc", "pop", "grade", "auction", "market", "recent sales", "last sold", "how much", "sell for", "asking price", "current price", "market value", "ebay", "goldin", "pwcc", "pop report", "serial numbered", "parallel", "variation", "print run", "numbered", "1/1", "superfractor", "rc logo", "rookie card"
  if (/(worth|value|comp|comps|price|fmv|shimmer|refractor|gold|blue|purple|auto|psa|bgs|sgc|pop|grade|auction|market|recent sales|last sold|how much|sell for|asking price|current price|market value|ebay|goldin|pwcc|pop report|serial numbered|parallel|variation|print run|numbered|1\/1|superfractor|rc logo|rookie card)/.test(q)) return "compiq";
  // Ambiguous/general card analysis fallback
  return "general_card_analysis";
}

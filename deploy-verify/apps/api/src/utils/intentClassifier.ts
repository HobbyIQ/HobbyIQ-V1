// Lightweight parser for extracting card info from natural queries
export function parseQuery(query: string) {
  const result: any = {};
  if (!query) return result;
  // Player: try to find two capitalized words, fallback to best guess
  const playerMatch = query.match(/([A-Z][a-z]+ [A-Z][a-z]+)/) || query.match(/([A-Z][a-z]+(?: [A-Z][a-z]+)?)/);
  if (playerMatch) result.player = playerMatch[1];
  // Parallel/color: match common and compound parallels
  const parallelMatch = query.match(/(true gold|true blue|blue shimmer|gold shimmer|blue wave|gold wave|purple shimmer|green shimmer|orange shimmer|red shimmer|black shimmer|superfractor|refractor|mojo|shimmer|chrome|paper|base|blue|gold|purple|green|orange|red|black)/i);
  if (parallelMatch) result.parallel = parallelMatch[1].toLowerCase();
  // Auto/non-auto
  if (/\bauto\b/i.test(query) && !/non[- ]?auto/i.test(query)) result.auto = true;
  if (/non[- ]?auto/i.test(query)) result.auto = false;
  // Serial number: /150, /499, 1/1, #/25, etc
  const serialMatch = query.match(/(?:#|\/)(\d{1,4})/);
  if (serialMatch) result.serial = serialMatch[1];
  // Compare phrasing
  if (/(compare|vs\.?|versus|better than|difference|head to head|which is better)/i.test(query)) result.compare = true;
  // Buy/sell/hold phrasing
  if (/(should i (buy|sell|hold|trade|keep|move|exit)|recommendation|decision|keep or sell|move|exit|buy or sell|sell now|hold now|is [a-z]+ [a-z]+ a buy|is [a-z]+ [a-z]+ a sell|is [a-z]+ a buy|is [a-z]+ a sell|buy candidate|sell candidate|add to pc|move on from|hold candidate|should i sell|should i buy|should i hold)/i.test(query)) {
    result.buySell = true;
  }
  // Extract left/right for compare
  if (result.compare) {
    // Try to split on vs, versus, compare, better than
    const compareMatch = query.match(/(.*?)(?: vs\.? | versus | vs | compare |better than)(.*)/i);
    if (compareMatch) {
      result.left = compareMatch[1] ? compareMatch[1].trim() : undefined;
      result.right = compareMatch[2] ? compareMatch[2].trim() : undefined;
    }
  }
  return result;
}

export type HobbyIQIntent =
  | "playeriq"
  | "compiq"
  | "compare"
  | "buy_sell_decision"
  | "general_card_analysis"
  | "unknown";


// Extract player/card name using lightweight heuristics
export function extractPlayerOrCard(query: string): string | null {
  if (!query) return null;
  // Look for patterns like "[Firstname Lastname] [card details]"
  const playerMatch = query.match(/([A-Z][a-z]+ [A-Z][a-z]+|[A-Z][a-z]+)$/);
  if (playerMatch) return playerMatch[1];
  // Try to find a capitalized word (for single names)
  const single = query.match(/([A-Z][a-z]+)/);
  return single ? single[1] : null;
}

// Improved intent classifier
export function classifyIntent(query: string): HobbyIQIntent {
  if (!query || typeof query !== 'string' || !query.trim()) return "unknown";
  const q = query.toLowerCase();

  // Compare intent (strongest match, now supports color/parallel compare)
  if (/(compare|vs\.?|versus|better than|difference|head to head|who wins|which is better|vs | vs )/i.test(q) || /\b(blue|gold|purple|auto|shimmer|refractor|base) vs (blue|gold|purple|auto|shimmer|refractor|base)\b/i.test(q)) {
    return "compare";
  }

  // Buy/Sell/Decision intent (expanded)
  if (/(should i (buy|sell|hold|trade|keep|move|exit)|is now a good time|recommendation|decision|keep or sell|move|exit|buy or sell|sell now|hold now|is [a-z]+ [a-z]+ a buy|is [a-z]+ [a-z]+ a sell|is [a-z]+ a buy|is [a-z]+ a sell|buy candidate|sell candidate|add to pc|move on from|hold candidate)/i.test(q)) {
    return "buy_sell_decision";
  }

  // PlayerIQ intent (player ability, scouting, prospecting, "is X a buy" now handled above)
  if (/(how (good|talented) is|is [a-z]+ [a-z]+ (good|talented)|player profile|scouting report|prospect|rookie|potential|talent|future star|should i draft|breakout candidate|mlb debut|call up)/i.test(q)) {
    return "playeriq";
  }

  // CompIQ intent (value, price, worth, FMV, "what is X worth")
  if (/(worth|value|fmv|price|how much|what is.*worth|what is.*value|what is.*price|sell for|buy for|market value|current value|recent sales|comp(s)?|comparable sales|last sold|recently sold|ebay|auction)/i.test(q)) {
    return "compiq";
  }

  // General card analysis (card features, set, year, parallel, serial, etc)
  if (/(auto|refractor|shimmer|mojo|gold|blue|purple|green|orange|red|black|superfractor|chrome|paper|serial|psa|bgs|sgc|graded|raw|numbered|parallel|variation|ssp|sp|insert|rookie card|rc|patch|jersey|on card|sticker|mint|gem|pop report|population|print run|year|\d{2,4})/i.test(q)) {
    return "general_card_analysis";
  }

  // Fallback
  return "unknown";
}

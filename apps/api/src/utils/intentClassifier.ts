import type { UniversalSearchIntent } from "../types/universal";

// Simple keyword-based intent classifier (replace with AI/NLP later)
export function classifyIntent(query: string): UniversalSearchIntent {
  const q = query.toLowerCase();
  if (/comp|worth|fmv|value|price|how much|what is/i.test(q)) return "comp";
  if (/sell|move|list|auction|bin|counteroffer|exit/i.test(q)) return "sell";
  if (/hold|wait|window|when to/i.test(q)) return "hold";
  if (/show|bring|table|sticker|walk away|bundle/i.test(q)) return "show";
  if (/portfolio|my cards|owned|cost basis|exposure/i.test(q)) return "portfolio";
  // Only return valid UniversalSearchIntent values
  return "unknown";
}

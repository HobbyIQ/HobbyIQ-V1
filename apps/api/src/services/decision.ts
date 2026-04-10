// Placeholder for future Decision Layer module
import type { PortfolioEntry } from "../types/modules";

export function makeDecision(card: PortfolioEntry) {
  // Mock decision logic: random buy/hold/sell
  const options = ["BUY", "HOLD", "SELL"];
  return {
    cardId: card.id,
    action: options[Math.floor(Math.random() * options.length)],
    reason: "Mock decision for demonstration purposes."
  };
}

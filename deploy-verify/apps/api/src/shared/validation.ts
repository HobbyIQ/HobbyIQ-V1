import type { PortfolioAddRequest } from "./types";
export function validatePortfolioAddRequest(input: PortfolioAddRequest) {
  if (!input || typeof input.cardTitle !== "string" || !input.cardTitle.trim()) {
    throw new Error("Invalid request: 'cardTitle' is required.");
  }
  if (typeof input.quantity !== "number" || input.quantity <= 0) {
    throw new Error("Invalid request: 'quantity' must be a positive number.");
  }
  if (typeof input.costBasis !== "number" || input.costBasis < 0) {
    throw new Error("Invalid request: 'costBasis' must be a non-negative number.");
  }
}
import type { CompIQRequest, PlayerIQRequest } from "./types";

export function validateCompIQRequest(input: CompIQRequest) {
  if (!input || typeof input.query !== "string" || !input.query.trim()) {
    throw new Error("Invalid request: 'query' is required.");
  }
}

export function validatePlayerIQRequest(input: PlayerIQRequest) {
  if (!input || typeof input.player !== "string" || !input.player.trim()) {
    throw new Error("Invalid request: 'player' is required.");
  }
}

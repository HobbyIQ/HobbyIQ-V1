import { PlayerIQRequest } from "./types";

export interface PlayerIQScores {
  overall: number;
  talent: number;
  market: number;
}

// Locked PlayerIQ scoring framework (example logic, replace with real model as needed)
export function scorePlayerIQ(input: PlayerIQRequest): PlayerIQScores {
  // Fallback: deterministic scoring for demo
  let base = 60;
  let talent = base;
  let market = base;
  if (/brady ebel/i.test(input.player)) {
    talent = 92;
    market = 80;
  } else if (/roman anthony/i.test(input.player)) {
    talent = 85;
    market = 78;
  } else if (/bonemer/i.test(input.player)) {
    talent = 70;
    market = 60;
  } else {
    // Partial/unknown
    talent = 60;
    market = 55;
  }
  const overall = Math.round((talent * 0.7) + (market * 0.3));
  return { overall, talent, market };
}

import { DailyIQBrief, DailyIQPlayerEntry } from "./types";

// Fallback/mock data generator (replace with real data source)
function getMockPlayerEntry(overrides: Partial<DailyIQPlayerEntry> = {}): DailyIQPlayerEntry {
  return {
    player: "Brady Ebel",
    organization: "Dodgers",
    level: "A",
    position: "SS",
    firstBowmanYear: 2023,
    statLine: "2-4, HR, 2B, 3 RBI, SB",
    performanceNote: "Elite bat speed, top prospect performance.",
    marketSignal: "Strong buy interest in color autos.",
    buySellTag: "Buy",
    trendNote: "Upward trend in market value.",
    watchReason: "Top 10 prospect, recent surge.",
    ...overrides
  };
}

export async function getDailyIQBrief(): Promise<DailyIQBrief> {
  // In production, replace with real data fetch/aggregation
  const briefDate = new Date().toISOString().slice(0, 10);
  return {
    success: true,
    briefDate,
    verifiedTopProspectPerformances: {
      hitters: [getMockPlayerEntry()],
      pitchers: [getMockPlayerEntry({ player: "Paul Skenes", position: "RHP", statLine: "6 IP, 1 ER, 9 K", buySellTag: "Hold", marketSignal: "Steady demand for 1st Bowman Chrome.", trendNote: "Stable.", watchReason: "Top overall pitching prospect." })],
    },
    prospectWatch: [getMockPlayerEntry({ player: "Roman Anthony", position: "OF", statLine: "1-3, 2B, BB", buySellTag: "Monitor", marketSignal: "Market watching for breakout.", trendNote: "Potential riser.", watchReason: "Breakout candidate." })],
    hobbyMovers: [getMockPlayerEntry({ player: "Bonemer", position: "3B", statLine: "3-5, HR, 2B, 4 RBI", buySellTag: "Sell", marketSignal: "Spike in sales after big game.", trendNote: "Short-term spike.", watchReason: "Recent performance surge." })],
    multiAppearanceTracker: [getMockPlayerEntry({ player: "Gavin Kilen", position: "SS", statLine: "2-4, 2B, SB", buySellTag: "Hold", marketSignal: "Consistent performer.", trendNote: "Steady.", watchReason: "Multiple appearances this week." })],
    warnings: ["This is fallback/mock data. Replace with live feed for production."],
    nextActions: ["View full player profiles", "Analyze card market comps"],
  };
}

// Locked DailyIQ response models

// Player entry for all DailyIQ sections
export interface DailyIQPlayerEntry {
  player: string;
  organization: string;
  level: string;
  position: string;
  firstBowmanYear: number | null;
  statLine: string;
  performanceNote: string;
  marketSignal: string;
  buySellTag: "Buy" | "Sell" | "Hold" | "Monitor";
  trendNote: string;
  watchReason: string;
}

// Main DailyIQ brief response contract
export interface DailyIQBrief {
  success: boolean;
  briefDate: string;
  verifiedTopProspectPerformances: {
    hitters: DailyIQPlayerEntry[];
    pitchers: DailyIQPlayerEntry[];
  };
  prospectWatch: DailyIQPlayerEntry[];
  hobbyMovers: DailyIQPlayerEntry[];
  multiAppearanceTracker: DailyIQPlayerEntry[];
  warnings: string[];
  nextActions: string[];
}

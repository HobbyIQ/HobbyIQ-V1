// Types for DailyIQ frontend

export interface DailyIQPlayerEntry {
  player: string;
  organization: string;
  level: string;
  position: string;
  firstBowmanYear: number;
  statLine: string;
  performanceNote: string;
  marketSignal: string;
  buySellTag: "Buy" | "Hold" | "Sell" | "Watch";
}

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

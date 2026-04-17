export type AlertSignalType =
  | "entered_buy_zone"
  | "entered_sell_zone"
  | "supply_tightened"
  | "demand_weakened"
  | "player_outlook_positive"
  | "recommendation_upgraded"
  | "risk_spiked"
  | "market_overheated";

export interface AlertSignal {
  signalId: string;
  entityType: "card" | "player";
  entityKey: string;
  signalType: AlertSignalType;
  importanceScore: number;
  summary: string;
  payloadJson: Record<string, unknown>;
  createdAt: string;
}

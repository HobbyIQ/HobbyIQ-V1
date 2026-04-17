export type AlertRuleType =
  | "entered_buy_zone"
  | "entered_sell_zone"
  | "entered_trim_zone"
  | "recommendation_changed"
  | "risk_spiked"
  | "market_temperature_changed"
  | "supply_tightened"
  | "demand_weakened"
  | "player_outlook_upgraded"
  | "player_outlook_downgraded"
  | "catalyst_added"
  | "portfolio_overexposed"
  | "portfolio_exit_signal"
  | "dailyiq_mover";

export interface AlertRule {
  ruleId: string;
  ruleType: AlertRuleType;
  enabled: boolean;
  minConfidence: number;
  minSignificanceScore: number;
  cooldownMinutes: number;
  metadataJson?: Record<string, unknown>;
}

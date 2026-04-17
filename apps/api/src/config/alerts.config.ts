export interface AlertsConfig {
  defaultMinConfidence: number;
  defaultMinSignificanceScore: number;
  alertCooldownMinutes: number;
  maxAlertsPerEntityPerDay: number;
  maxAlertsPerUserPerDay: number;
  suppressLowConfidenceAlerts: boolean;
  suppressThinMarketAlerts: boolean;
  allowDailyIqMoverAlerts: boolean;
  allowPortfolioAlerts: boolean;
}

export const alertsConfig: AlertsConfig = {
  defaultMinConfidence: Number(process.env.ALERTS_DEFAULT_MIN_CONFIDENCE ?? 65),
  defaultMinSignificanceScore: Number(process.env.ALERTS_DEFAULT_MIN_SIGNIFICANCE_SCORE ?? 25),
  alertCooldownMinutes: Number(process.env.ALERTS_COOLDOWN_MINUTES ?? 360),
  maxAlertsPerEntityPerDay: Number(process.env.ALERTS_MAX_PER_ENTITY_PER_DAY ?? 3),
  maxAlertsPerUserPerDay: Number(process.env.ALERTS_MAX_PER_USER_PER_DAY ?? 20),
  suppressLowConfidenceAlerts: String(process.env.ALERTS_SUPPRESS_LOW_CONFIDENCE ?? "true") === "true",
  suppressThinMarketAlerts: String(process.env.ALERTS_SUPPRESS_THIN_MARKET ?? "true") === "true",
  allowDailyIqMoverAlerts: String(process.env.ALERTS_ALLOW_DAILYIQ_MOVER_ALERTS ?? "true") === "true",
  allowPortfolioAlerts: String(process.env.ALERTS_ALLOW_PORTFOLIO_ALERTS ?? "true") === "true",
};

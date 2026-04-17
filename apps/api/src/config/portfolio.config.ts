export interface PortfolioConfig {
  methodologyVersion: string;
  overexposureAllocationThresholdPct: number;
  trimGainPctThreshold: number;
  protectCapitalDrawdownPct: number;
  strongAddDiscountPct: number;
  defaultCurrency: string;
  allowLotTracking: boolean;
  enablePortfolioRollups: boolean;
  enablePortfolioAlertSync: boolean;
}

export const portfolioConfig: PortfolioConfig = {
  methodologyVersion: process.env.PORTFOLIO_METHODOLOGY_VERSION || "v1",
  overexposureAllocationThresholdPct: Number(process.env.PORTFOLIO_OVEREXPOSURE_THRESHOLD_PCT ?? 20),
  trimGainPctThreshold: Number(process.env.PORTFOLIO_TRIM_GAIN_THRESHOLD_PCT ?? 40),
  protectCapitalDrawdownPct: Number(process.env.PORTFOLIO_PROTECT_CAPITAL_DRAWDOWN_PCT ?? 15),
  strongAddDiscountPct: Number(process.env.PORTFOLIO_STRONG_ADD_DISCOUNT_PCT ?? 10),
  defaultCurrency: process.env.PORTFOLIO_DEFAULT_CURRENCY || "USD",
  allowLotTracking: String(process.env.PORTFOLIO_ALLOW_LOT_TRACKING ?? "true") === "true",
  enablePortfolioRollups: String(process.env.PORTFOLIO_ENABLE_ROLLUPS ?? "true") === "true",
  enablePortfolioAlertSync: String(process.env.PORTFOLIO_ENABLE_ALERT_SYNC ?? "true") === "true",
};

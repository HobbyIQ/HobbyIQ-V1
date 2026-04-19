"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioSummaryCard = PortfolioSummaryCard;
const react_1 = __importDefault(require("react"));
function PortfolioSummaryCard({ summary }) {
    return (<div style={{ background: '#222', borderRadius: 24, padding: 20, marginBottom: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 18 }}>Portfolio Summary</div>
      <div>Total Value: {summary.totalEstimatedValue}</div>
      <div>Cost Basis: {summary.totalCostBasis}</div>
      <div>Unrealized Gain/Loss: {summary.totalUnrealizedGainLoss}</div>
      <div>Buy More: {summary.buyMoreCount} | Hold: {summary.holdCount} | Trim: {summary.trimCount} | Sell: {summary.sellCount} | Watch: {summary.watchCount}</div>
    </div>);
}

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioPositionDetailScreen = PortfolioPositionDetailScreen;
const react_1 = __importDefault(require("react"));
const usePortfolioPosition_1 = require("../hooks/usePortfolioPosition");
function PortfolioPositionDetailScreen({ positionId, onBack }) {
    const { data, isLoading } = (0, usePortfolioPosition_1.usePortfolioPosition)(positionId);
    if (isLoading)
        return <div style={{ color: '#aaa' }}>Loading...</div>;
    if (!data)
        return <div style={{ color: '#c33' }}>Position not found</div>;
    return (<div style={{ padding: 24 }}>
      <button onClick={onBack} style={{ marginBottom: 16 }}>Back</button>
      <div style={{ background: '#222', borderRadius: 24, padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 18 }}>{data.position.displayLabel || data.position.entityKey}</div>
        <div>Quantity: {data.position.quantity}</div>
        <div>Avg Cost: {data.position.averageCost}</div>
        <div>Current Value: {data.metrics.currentTotalValue}</div>
        <div>Unrealized Gain/Loss: {data.metrics.unrealizedGainLoss} ({data.metrics.unrealizedGainLossPct}%)</div>
        <div>Action: {data.actionPlan.recommendedAction}</div>
        <div>Summary: {data.actionPlan.summary}</div>
        <div>Why Now:</div>
        <ul>{data.actionPlan.whyNow.map((w, i) => <li key={i}>{w}</li>)}</ul>
        <div>Action Steps:</div>
        <ul>{data.actionPlan.actionSteps.map((s, i) => <li key={i}>{s}</li>)}</ul>
      </div>
    </div>);
}

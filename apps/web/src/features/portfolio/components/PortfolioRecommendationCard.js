"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioRecommendationCard = PortfolioRecommendationCard;
const react_1 = __importDefault(require("react"));
function PortfolioRecommendationCard({ actionPlan }) {
    return (<div style={{ background: '#222', borderRadius: 24, padding: 20, marginBottom: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 18 }}>Recommendation</div>
      <div>Action: {actionPlan.recommendedAction}</div>
      <div>Summary: {actionPlan.summary}</div>
      <div>Why Now:</div>
      <ul>{actionPlan.whyNow.map((w, i) => <li key={i}>{w}</li>)}</ul>
      <div>Action Steps:</div>
      <ul>{actionPlan.actionSteps.map((s, i) => <li key={i}>{s}</li>)}</ul>
    </div>);
}

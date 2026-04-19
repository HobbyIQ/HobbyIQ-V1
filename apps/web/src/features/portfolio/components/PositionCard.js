"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PositionCard = PositionCard;
const react_1 = __importDefault(require("react"));
function PositionCard({ view, onClick }) {
    return (<div onClick={onClick} style={{ background: '#222', borderRadius: 24, boxShadow: '0 2px 8px #0004', padding: 20, marginBottom: 16, cursor: onClick ? 'pointer' : undefined }}>
      <div style={{ fontWeight: 700, fontSize: 18 }}>{view.position.displayLabel || view.position.entityKey}</div>
      <div style={{ margin: '8px 0', color: '#aaa' }}>Qty: {view.position.quantity} | Avg Cost: {view.position.averageCost ?? '-'} | Value: {view.metrics.currentTotalValue ?? '-'}</div>
      <div style={{ color: view.metrics.unrealizedGainLoss && view.metrics.unrealizedGainLoss > 0 ? '#1a3' : view.metrics.unrealizedGainLoss && view.metrics.unrealizedGainLoss < 0 ? '#c33' : '#fff', fontWeight: 600 }}>
        Gain/Loss: {view.metrics.unrealizedGainLoss != null ? view.metrics.unrealizedGainLoss.toFixed(2) : '-'} ({view.metrics.unrealizedGainLossPct != null ? view.metrics.unrealizedGainLossPct.toFixed(1) + '%' : '-'})
      </div>
      <div style={{ marginTop: 8 }}>
        <span style={{ background: '#333', borderRadius: 12, padding: '2px 10px', color: '#fff', fontWeight: 500 }}>{view.actionPlan.recommendedAction.toUpperCase()}</span>
        <span style={{ marginLeft: 12, color: '#aaa' }}>{view.actionPlan.summary}</span>
      </div>
      {view.actionPlan.whyNow && view.actionPlan.whyNow.length > 0 && (<ul style={{ margin: '8px 0 0 0', padding: 0, listStyle: 'none', color: '#aaa', fontSize: 13 }}>
          {view.actionPlan.whyNow.slice(0, 2).map((w, i) => <li key={i}>• {w}</li>)}
        </ul>)}
    </div>);
}

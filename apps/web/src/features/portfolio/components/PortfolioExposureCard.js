"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioExposureCard = PortfolioExposureCard;
const react_1 = __importDefault(require("react"));
function PortfolioExposureCard({ exposure }) {
    return (<div style={{ background: '#222', borderRadius: 24, padding: 20, marginBottom: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 18 }}>Portfolio Exposure</div>
      {exposure.items.map((item, i) => (<div key={i} style={{ color: item.overexposed ? '#c33' : '#aaa' }}>
          {item.entityKey}: {item.exposureScore.toFixed(1)}% {item.overexposed && '⚠️'}
          {item.notes.map((n, j) => <div key={j} style={{ fontSize: 13 }}>{n}</div>)}
        </div>))}
    </div>);
}

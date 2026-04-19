"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioScreen = PortfolioScreen;
const react_1 = __importStar(require("react"));
const usePortfolioPositions_1 = require("../hooks/usePortfolioPositions");
const AddPositionButton_1 = require("../components/AddPositionButton");
const PositionCard_1 = require("../components/PositionCard");
const PositionEmptyState_1 = require("../components/PositionEmptyState");
const PositionForm_1 = require("../components/PositionForm");
function PortfolioScreen() {
    const { data: positions, isLoading } = (0, usePortfolioPositions_1.usePortfolioPositions)();
    const { data: summary } = (0, usePortfolioPositions_1.usePortfolioSummary)();
    const { data: allocation } = (0, usePortfolioPositions_1.usePortfolioAllocation)();
    const { data: recommendations } = (0, usePortfolioPositions_1.usePortfolioRecommendations)();
    const [showForm, setShowForm] = (0, react_1.useState)(false);
    return (<div style={{ padding: 24, maxWidth: 600, margin: '0 auto' }}>
      <h1 style={{ color: '#fff', fontSize: 28, fontWeight: 700 }}>Portfolio</h1>
      {summary && (<div style={{ background: '#222', borderRadius: 24, padding: 20, marginBottom: 16 }}>
          <div>Total Value: {summary.totalEstimatedValue}</div>
          <div>Cost Basis: {summary.totalCostBasis}</div>
          <div>Unrealized Gain/Loss: {summary.totalUnrealizedGainLoss}</div>
        </div>)}
      {allocation && (<div style={{ background: '#222', borderRadius: 24, padding: 20, marginBottom: 16 }}>
          <div style={{ fontWeight: 600 }}>Top Allocations</div>
          {allocation.items.slice(0, 3).map((item, i) => (<div key={i}>{item.displayLabel || item.entityKey}: {item.allocationPct.toFixed(1)}%</div>))}
        </div>)}
      <AddPositionButton_1.AddPositionButton onClick={() => setShowForm(true)}/>
      {showForm && <PositionForm_1.PositionForm onSubmit={() => setShowForm(false)} onCancel={() => setShowForm(false)}/>}
      {isLoading ? (<div style={{ color: '#aaa', marginTop: 32 }}>Loading...</div>) : positions && positions.length > 0 ? (positions.map((view, i) => <PositionCard_1.PositionCard key={i} view={view}/>)) : (<PositionEmptyState_1.PositionEmptyState />)}
    </div>);
}

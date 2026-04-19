"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PositionEmptyState = PositionEmptyState;
const react_1 = __importDefault(require("react"));
function PositionEmptyState() {
    return (<div style={{ color: '#aaa', textAlign: 'center', marginTop: 48 }}>
      <div style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}>No positions yet</div>
      <div>Add your first position to start tracking cost basis, ROI, and personalized recommendations.</div>
    </div>);
}

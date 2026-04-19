"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddPositionButton = AddPositionButton;
const react_1 = __importDefault(require("react"));
function AddPositionButton({ onClick }) {
    return (<button onClick={onClick} style={{ padding: 12, borderRadius: 16, background: '#1a3', color: '#fff', fontWeight: 600 }}>
      + Add Position
    </button>);
}

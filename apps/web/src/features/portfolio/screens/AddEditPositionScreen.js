"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddEditPositionScreen = AddEditPositionScreen;
const react_1 = __importDefault(require("react"));
const PositionForm_1 = require("../components/PositionForm");
const useCreatePortfolioPosition_1 = require("../hooks/useCreatePortfolioPosition");
function AddEditPositionScreen({ initial, onClose }) {
    const { mutate } = (0, useCreatePortfolioPosition_1.useCreatePortfolioPosition)();
    return (<div style={{ padding: 24 }}>
      <h2 style={{ color: '#fff' }}>{initial ? 'Edit Position' : 'Add Position'}</h2>
      <PositionForm_1.PositionForm initial={initial} onSubmit={data => {
            mutate(data, { onSuccess: onClose });
        }} onCancel={onClose}/>
    </div>);
}

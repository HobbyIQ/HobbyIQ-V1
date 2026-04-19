"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = __importDefault(require("react"));
require("./EmptyState.css");
const EmptyState = ({ children }) => (<div className="hiq-empty-state">{children}</div>);
exports.default = EmptyState;

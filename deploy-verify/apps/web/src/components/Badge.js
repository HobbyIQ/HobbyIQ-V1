"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = __importDefault(require("react"));
require("./Badge.css");
const Badge = ({ color, children, className = "" }) => (<span className={`hiq-badge ${className}`} style={color ? { background: color } : {}}>{children}</span>);
exports.default = Badge;

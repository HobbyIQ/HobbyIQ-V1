"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = __importDefault(require("react"));
require("./Card.css");
const Card = ({ children, className = "", style }) => (<div className={`hiq-card ${className}`} style={style}>{children}</div>);
exports.default = Card;

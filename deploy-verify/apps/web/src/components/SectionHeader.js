"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = __importDefault(require("react"));
require("./SectionHeader.css");
const SectionHeader = ({ children, sub }) => (<h2 className={sub ? "hiq-section-header hiq-section-sub" : "hiq-section-header"}>{children}</h2>);
exports.default = SectionHeader;

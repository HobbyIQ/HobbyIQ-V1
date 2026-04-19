"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = __importDefault(require("react"));
require("./LoadingBlock.css");
const LoadingBlock = ({ children }) => (<div className="hiq-loading-block">{children || "Loading..."}</div>);
exports.default = LoadingBlock;

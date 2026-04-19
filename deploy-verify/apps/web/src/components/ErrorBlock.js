"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = __importDefault(require("react"));
require("./ErrorBlock.css");
const ErrorBlock = ({ children }) => (<div className="hiq-error-block">{children}</div>);
exports.default = ErrorBlock;

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = __importDefault(require("react"));
require("./Button.css");
const Button = ({ children, className = "", ...props }) => (<button className={`hiq-btn ${className}`} {...props}>{children}</button>);
exports.default = Button;

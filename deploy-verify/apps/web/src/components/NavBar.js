"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = NavBar;
const react_1 = __importDefault(require("react"));
// import { Link } from "react-router-dom";
// To fix: install react-router-dom and its types if routing is needed.
const navStyle = {
    display: "flex",
    gap: "1.5rem",
    padding: "1rem",
    background: "#f5f5f5",
    borderBottom: "1px solid #eee",
    justifyContent: "center",
    fontFamily: "sans-serif",
};
function NavBar() {
    return (<nav style={navStyle}>
      <a href="/analyze">Analyze</a>
      <a href="/portfolio">Portfolio</a>
      <a href="/alerts">Alerts</a>
    </nav>);
}

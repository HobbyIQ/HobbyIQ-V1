"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vite_1 = require("vite");
const plugin_react_1 = __importDefault(require("@vitejs/plugin-react"));
const API_BASE_URL = process.env.VITE_API_BASE_URL || 'http://localhost:4000';
exports.default = (0, vite_1.defineConfig)({
    plugins: [(0, plugin_react_1.default)()],
    server: {
        proxy: {
            '/compiq': API_BASE_URL,
            '/portfolio': API_BASE_URL,
        },
        port: 5173,
        open: true,
    },
});

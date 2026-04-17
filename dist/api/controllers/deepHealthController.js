"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deepHealthController = deepHealthController;
const os_1 = __importDefault(require("os"));
function deepHealthController(_req, res) {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: os_1.default.loadavg(),
        env: process.env.NODE_ENV,
        timestamp: new Date().toISOString()
    });
}

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// === Hardened Azure Startup (Minimal, Compiled Output Only) ===
const express_1 = __importDefault(require("express"));
console.log('=== HobbyIQ MINIMAL STARTUP ===');
console.log('Node version:', process.version);
console.log('PORT:', process.env.PORT);
process.on('uncaughtException', err => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', err => {
    console.error('UNHANDLED REJECTION:', err);
});
const app = (0, express_1.default)();
app.use(express_1.default.json());
// Health endpoint only
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'HobbyIQ running' });
});
const port = parseInt(process.env.PORT || '8080', 10);
app.listen(port, '0.0.0.0', () => {
    console.log(`HobbyIQ minimal server listening on ${port}`);
});

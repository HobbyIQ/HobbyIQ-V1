"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const portfolioIQ_1 = require("../engines/portfolioIQ");
const router = express_1.default.Router();
// POST /api/portfolioiq/add-holding
router.post("/add-holding", async (req, res) => {
    try {
        const input = req.body;
        const result = await (0, portfolioIQ_1.handleAddHolding)(input);
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
// GET /api/portfolioiq/list-holdings
router.get("/list-holdings", async (_req, res) => {
    try {
        const result = await (0, portfolioIQ_1.handleListHoldings)();
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
// GET /api/portfolioiq/summary
router.get("/summary", async (_req, res) => {
    try {
        const result = await (0, portfolioIQ_1.handlePortfolioSummary)();
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
exports.default = router;

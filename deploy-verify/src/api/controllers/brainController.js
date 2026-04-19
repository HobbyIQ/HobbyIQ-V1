"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.playerSummaryController = exports.marketMoversController = exports.bestBuysController = exports.healthController = exports.cardDecisionController = void 0;
const cardDecisionSchema_1 = require("../../brain/schemas/cardDecisionSchema");
const cardDecisionHandler_1 = require("../../brain/handlers/cardDecisionHandler");
const marketHandlers_1 = require("../../brain/handlers/marketHandlers");
const cardDecisionController = async (req, res) => {
    const { error, value } = (0, cardDecisionSchema_1.validateCardDecision)(req.body);
    if (error) {
        return res.status(400).json({ success: false, error: error.details.map(d => d.message) });
    }
    try {
        const result = await (0, cardDecisionHandler_1.cardDecisionHandler)(value);
        res.json(result);
    }
    catch (err) {
        console.error('Card decision error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};
exports.cardDecisionController = cardDecisionController;
const healthController = (_req, res) => {
    res.json({ status: 'MCP HobbyIQ Brain running' });
};
exports.healthController = healthController;
const bestBuysController = async (_req, res) => {
    try {
        const result = await (0, marketHandlers_1.getBestBuys)();
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};
exports.bestBuysController = bestBuysController;
const marketMoversController = async (_req, res) => {
    try {
        const result = await (0, marketHandlers_1.getMarketMovers)();
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};
exports.marketMoversController = marketMoversController;
const playerSummaryController = async (req, res) => {
    try {
        const result = await (0, marketHandlers_1.getPlayerSummary)(req.params.player);
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};
exports.playerSummaryController = playerSummaryController;

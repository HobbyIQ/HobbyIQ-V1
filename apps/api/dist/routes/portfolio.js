"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
// @ts-ignore
const index_1 = require("../../engines/compiq/index");
const portfolioIQ_1 = require("../engines/portfolioIQ");
const router = (0, express_1.Router)();
// POST /portfolio/evaluate: Evaluate a portfolio of cards
router.post("/evaluate", async (req, res) => {
    const cards = req.body;
    if (!Array.isArray(cards) || cards.length === 0) {
        return res.status(400).json({ success: false, error: "Input must be a non-empty array of cards" });
    }
    try {
        const compResultsMap = {};
        for (const card of cards) {
            const { player, set, parallel } = card;
            const query = [player, set, parallel].filter(Boolean).join(" ");
            const compResult = await (0, index_1.handleCompIQLiveEstimate)({ query });
            const key = (player + "|" + parallel).toLowerCase().trim();
            compResultsMap[key] = compResult;
        }
        const evaluated = (0, portfolioIQ_1.evaluatePortfolio)(cards, compResultsMap);
        return res.json({ success: true, result: evaluated });
    }
    catch (err) {
        console.error("/portfolio/evaluate error", err);
        return res.status(500).json({ success: false, error: "Failed to evaluate portfolio" });
    }
});
exports.default = router;

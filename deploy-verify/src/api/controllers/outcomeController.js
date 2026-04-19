"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cardOutcomeController = void 0;
const cardOutcomeSchema_1 = require("../../brain/schemas/cardOutcomeSchema");
const cardOutcomeHandler_1 = require("../../brain/handlers/cardOutcomeHandler");
const cardOutcomeController = async (req, res) => {
    const { error, value } = (0, cardOutcomeSchema_1.validateCardOutcome)(req.body);
    if (error) {
        return res.status(400).json({ success: false, error: error.details.map(d => d.message) });
    }
    try {
        const result = await (0, cardOutcomeHandler_1.cardOutcomeHandler)(value);
        res.json(result);
    }
    catch (err) {
        console.error('Card outcome error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};
exports.cardOutcomeController = cardOutcomeController;

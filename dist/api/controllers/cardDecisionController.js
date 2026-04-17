"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cardDecisionController = cardDecisionController;
const cardDecisionHandler_1 = require("../../brain/handlers/cardDecisionHandler");
async function cardDecisionController(req, res) {
    try {
        const result = await (0, cardDecisionHandler_1.cardDecisionHandler)(req.body);
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

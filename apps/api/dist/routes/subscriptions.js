"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const subscription_1 = require("../services/subscription");
const router = (0, express_1.Router)();
// GET /api/subscription
router.get("/subscription", (_req, res) => {
    // In production, use userId from auth/session
    const subscription = (0, subscription_1.getSubscription)("demo");
    res.json({ subscription });
});
// POST /api/subscription/validate-apple
router.post("/subscription/validate-apple", async (req, res) => {
    const { receipt } = req.body;
    if (!receipt)
        return res.status(400).json({ error: "Missing receipt" });
    try {
        const result = await (0, subscription_1.validateAppleReceipt)(receipt);
        res.json({ valid: result });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;

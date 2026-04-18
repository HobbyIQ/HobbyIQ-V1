"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const providerHealth_1 = require("../services/providerHealth");
const router = (0, express_1.Router)();
// GET /api/provider-health
router.get("/provider-health", async (_req, res) => {
    const health = await (0, providerHealth_1.getAllProviderHealth)();
    res.json({ health });
});
exports.default = router;

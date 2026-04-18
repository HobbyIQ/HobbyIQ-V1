"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
router.get("/test", (_req, res) => {
    res.json({
        message: "HobbyIQ API is working",
        timestamp: new Date().toISOString()
    });
});
exports.default = router;

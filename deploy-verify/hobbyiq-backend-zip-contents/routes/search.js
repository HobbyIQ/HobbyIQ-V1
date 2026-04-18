"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const service_1 = require("../search/service");
const router = (0, express_1.Router)();
router.post("/", async (req, res) => {
    const body = req.body;
    try {
        const response = await (0, service_1.handleSearch)(body);
        return res.json(response);
    }
    catch (err) {
        return res.status(500).json({ error: err.message || "Internal server error" });
    }
});
exports.default = router;

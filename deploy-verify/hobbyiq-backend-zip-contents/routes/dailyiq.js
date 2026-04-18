"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const dailyiq_1 = require("../engines/dailyiq");
const router = express_1.default.Router();
// GET /api/dailyiq/brief: Daily Prospect + Hobby Engine
router.get("/brief", async (req, res) => {
    try {
        const result = await (0, dailyiq_1.handleDailyIQBrief)();
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
exports.default = router;

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const playeriq_1 = require("../engines/playeriq");
const router = express_1.default.Router();
// POST /api/playeriq/query (alias for /evaluate)
router.post("/query", async (req, res) => {
    try {
        const input = req.body;
        const result = await (0, playeriq_1.handlePlayerIQEvaluate)(input);
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
// POST /api/playeriq/evaluate: Player + Card Intelligence
router.post("/evaluate", async (req, res) => {
    try {
        const input = req.body;
        const result = await (0, playeriq_1.handlePlayerIQEvaluate)(input);
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
exports.default = router;

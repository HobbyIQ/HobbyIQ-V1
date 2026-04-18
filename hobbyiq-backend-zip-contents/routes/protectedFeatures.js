"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const requireFeature_1 = require("../middleware/requireFeature");
const router = express_1.default.Router();
// Sample protected route: alerts.realtime
router.get("/alerts/realtime", (0, requireFeature_1.requireFeature)("alerts.realtime"), (req, res) => {
    res.json({ success: true, message: "You have access to real-time alerts!" });
});
// Sample protected route: decision.engine
router.get("/decision/engine", (0, requireFeature_1.requireFeature)("decision.engine"), (req, res) => {
    res.json({ success: true, message: "You have access to the decision engine!" });
});
// Sample protected route: selliq.full
router.get("/selliq/full", (0, requireFeature_1.requireFeature)("selliq.full"), (req, res) => {
    res.json({ success: true, message: "You have access to SellIQ Full!" });
});
exports.default = router;

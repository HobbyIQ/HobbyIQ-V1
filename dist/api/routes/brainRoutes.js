"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const brainController_1 = require("../controllers/brainController");
const fullAnalysisController_1 = require("../controllers/fullAnalysisController");
const router = express_1.default.Router();
router.get('/health', (req, res) => res.json({ status: 'MCP HobbyIQ Brain running' }));
router.post('/card-decision', brainController_1.cardDecisionController);
router.get('/best-buys', brainController_1.bestBuysController);
router.get('/market-movers', brainController_1.marketMoversController);
router.get('/player-summary/:player', brainController_1.playerSummaryController);
router.post('/full-analysis', fullAnalysisController_1.fullAnalysisController);
exports.default = router;

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const fullAnalysisController_1 = require("../../controllers/fullAnalysisController");
const router = express_1.default.Router();
router.post('/full-analysis', fullAnalysisController_1.fullAnalysisController);
exports.default = router;

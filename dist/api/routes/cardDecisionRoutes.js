"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const cardDecisionController_1 = require("../controllers/cardDecisionController");
const router = (0, express_1.Router)();
router.post('/card-decision', cardDecisionController_1.cardDecisionController);
exports.default = router;

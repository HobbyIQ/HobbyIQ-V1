"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const compiq_controller_1 = require("../controllers/compiq.controller");
const router = (0, express_1.Router)();
router.post('/query', compiq_controller_1.compiqQuery);
router.post('/estimate', compiq_controller_1.compiqEstimate);
router.get('/health', compiq_controller_1.compiqHealth);
exports.default = router;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const deepHealthController_1 = require("../../controllers/deepHealthController");
const router = (0, express_1.Router)();
router.get('/deep-health', deepHealthController_1.deepHealthController);
exports.default = router;

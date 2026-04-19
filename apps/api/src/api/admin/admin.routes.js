"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const diagnostics_controller_1 = __importDefault(require("../../admin/diagnostics/diagnostics.controller"));
const ops_controller_1 = __importDefault(require("../../admin/ops/ops.controller"));
const review_controller_1 = __importDefault(require("../../admin/review/review.controller"));
const router = (0, express_1.Router)();
router.use('/diagnostics', diagnostics_controller_1.default);
router.use('/ops', ops_controller_1.default);
router.use('/review', review_controller_1.default);
exports.default = router;

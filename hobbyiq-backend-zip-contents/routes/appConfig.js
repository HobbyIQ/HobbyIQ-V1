"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// Central app config/bootstrap endpoint for HobbyIQ frontend/mobile
const express_1 = require("express");
const plans_1 = require("../constants/plans");
const planTiers_1 = require("../models/planTiers");
const FeatureKey = __importStar(require("../constants/features"));
const router = (0, express_1.Router)();
router.get("/bootstrap", (_req, res) => {
    res.json({
        plans: plans_1.PLAN_DEFINITIONS,
        planLimits: planTiers_1.PLAN_NOTIFICATION_LIMITS,
        features: Object.values(FeatureKey),
        env: {
            NODE_ENV: process.env.NODE_ENV,
            CLIENT_APP_URL: process.env.CLIENT_APP_URL,
            AI_MODE: process.env.AI_MODE,
        },
        now: Date.now(),
    });
});
exports.default = router;

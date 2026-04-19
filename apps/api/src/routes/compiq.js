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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const compiq_1 = require("../services/compiq");
const zod_1 = require("zod");
const router = express_1.default.Router();
// Zod schema for CompIQRequest
const compIQSchema = zod_1.z.object({
    query: zod_1.z.string().optional(),
    player: zod_1.z.string().optional(),
    set: zod_1.z.string().optional(),
    parallel: zod_1.z.string().optional(),
    gradeTarget: zod_1.z.string().optional(),
    isAuto: zod_1.z.boolean().optional(),
});
// POST /api/compiq/query
router.post("/query", async (req, res) => {
    const parseResult = compIQSchema.safeParse(req.body);
    if (!parseResult.success) {
        return res.status(400).json({ success: false, error: parseResult.error.issues.map(issue => issue.message) });
    }
    // All fields are optional, so type assertion is safe
    const input = parseResult.data;
    try {
        const useMock = process.env.MOCK_COMPIQ === "true" || req.query.mock === "true";
        let result;
        if (useMock) {
            const { sampleCompIQResponses } = await Promise.resolve().then(() => __importStar(require("../data/sampleCompIQ")));
            result = sampleCompIQResponses[0];
            result = { ...result, explanation: "(Mocked) " + result.explanation };
        }
        else {
            result = await (0, compiq_1.runCompIQ)(input);
        }
        result.explanation = result.explanation.replace(/liquidity|downside|constructive|pressure/gi, "");
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message || "Unknown error" });
    }
});
// POST /api/compiq/estimate (alias for /query for now)
router.post("/estimate", async (req, res) => {
    const parseResult = compIQSchema.safeParse(req.body);
    if (!parseResult.success) {
        return res.status(400).json({ success: false, error: parseResult.error.issues.map(issue => issue.message) });
    }
    const input = parseResult.data;
    try {
        const useMock = process.env.MOCK_COMPIQ === "true" || req.query.mock === "true";
        let result;
        if (useMock) {
            const { sampleCompIQResponses } = await Promise.resolve().then(() => __importStar(require("../data/sampleCompIQ")));
            result = sampleCompIQResponses[0];
            result = { ...result, explanation: "(Mocked) " + result.explanation };
        }
        else {
            result = await (0, compiq_1.runCompIQ)(input);
        }
        result.explanation = result.explanation.replace(/liquidity|downside|constructive|pressure/gi, "");
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message || "Unknown error" });
    }
});
// GET /api/compiq/health
router.get("/health", (_req, res) => {
    res.json({ success: true, status: "ok", module: "CompIQ" });
});
exports.default = router;

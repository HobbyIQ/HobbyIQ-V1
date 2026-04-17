"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fullAnalysisSchema = void 0;
exports.validateFullAnalysis = validateFullAnalysis;
const zod_1 = require("zod");
exports.fullAnalysisSchema = zod_1.z.object({
    player: zod_1.z.string(),
    cardSet: zod_1.z.string(),
    year: zod_1.z.number(),
    product: zod_1.z.string(),
    parallel: zod_1.z.string().optional(),
    grade: zod_1.z.string().optional(),
    currentEstimatedValue: zod_1.z.number().optional(),
    askingPrice: zod_1.z.number().optional(),
    userIntent: zod_1.z.string().optional(),
    events: zod_1.z.array(zod_1.z.string()).optional()
});
function validateFullAnalysis(req, res, next) {
    try {
        exports.fullAnalysisSchema.parse(req.body);
        next();
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.errors || 'Validation error' });
    }
}

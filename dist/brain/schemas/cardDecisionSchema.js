"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cardDecisionSchema = void 0;
exports.validateCardDecision = validateCardDecision;
const joi_1 = __importDefault(require("joi"));
exports.cardDecisionSchema = joi_1.default.object({
    player: joi_1.default.string().required(),
    cardSet: joi_1.default.string().required(),
    year: joi_1.default.number().required(),
    product: joi_1.default.string().required(),
    parallel: joi_1.default.string().required(),
    serial: joi_1.default.string().allow(null, ''),
    grade: joi_1.default.string().required(),
    isAuto: joi_1.default.boolean().required(),
    askingPrice: joi_1.default.number().required(),
    userIntent: joi_1.default.string().valid('buy', 'hold', 'sell').required(),
});
function validateCardDecision(payload) {
    return exports.cardDecisionSchema.validate(payload, { abortEarly: false });
}

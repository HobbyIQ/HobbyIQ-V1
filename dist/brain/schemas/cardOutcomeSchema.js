"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cardOutcomeSchema = void 0;
exports.validateCardOutcome = validateCardOutcome;
const joi_1 = __importDefault(require("joi"));
exports.cardOutcomeSchema = joi_1.default.object({
    player: joi_1.default.string().required(),
    cardSet: joi_1.default.string().required(),
    year: joi_1.default.number().required(),
    product: joi_1.default.string().required(),
    parallel: joi_1.default.string().required(),
    grade: joi_1.default.string().required(),
    currentEstimatedValue: joi_1.default.number().required(),
    events: joi_1.default.array().items(joi_1.default.string()).required(),
});
function validateCardOutcome(payload) {
    return exports.cardOutcomeSchema.validate(payload, { abortEarly: false });
}

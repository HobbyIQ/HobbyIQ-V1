"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.postEstimate = postEstimate;
exports.printEstimateResult = printEstimateResult;
// Validation helpers for CompIQ estimate manual/local testing
const supertest_1 = __importDefault(require("supertest"));
async function postEstimate(app, payload) {
    return (0, supertest_1.default)(app).post('/api/compiq/estimate').send(payload);
}
function printEstimateResult(res) {
    // Pretty-print key fields for manual inspection
    const { verdict, dealScore, priceLanes, explanationBullets, observability } = res.body;
    console.log('Verdict:', verdict);
    console.log('Deal Score:', dealScore);
    console.log('Price Lanes:', priceLanes);
    if (explanationBullets)
        console.log('Explanation:', explanationBullets.join(' | '));
    if (observability)
        console.log('Observability:', observability);
}
// Example usage for local manual testing:
// import { strongBuyPayload } from './compiq-estimate.fixtures';
// const res = await postEstimate(app, strongBuyPayload);
// printEstimateResult(res);

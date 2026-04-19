"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPortfolio = getPortfolio;
// Placeholder for future Portfolio Tracking module
const mockPortfolio_1 = __importDefault(require("../data/mockPortfolio"));
function getPortfolio(userId) {
    // In production, filter by userId. Here, return all mock data.
    return mockPortfolio_1.default;
}

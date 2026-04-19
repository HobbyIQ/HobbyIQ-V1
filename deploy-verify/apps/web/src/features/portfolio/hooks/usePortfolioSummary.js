"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usePortfolioSummary = usePortfolioSummary;
const react_query_1 = require("react-query");
const portfolio_api_1 = require("../api/portfolio.api");
function usePortfolioSummary() {
    return (0, react_query_1.useQuery)(['portfolio-summary'], portfolio_api_1.getPortfolioSummary);
}

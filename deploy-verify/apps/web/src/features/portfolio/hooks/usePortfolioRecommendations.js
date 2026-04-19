"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usePortfolioRecommendations = usePortfolioRecommendations;
const react_query_1 = require("react-query");
const portfolio_api_1 = require("../api/portfolio.api");
function usePortfolioRecommendations() {
    return (0, react_query_1.useQuery)(['portfolio-recommendations'], portfolio_api_1.getPortfolioRecommendations);
}

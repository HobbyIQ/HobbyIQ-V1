"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usePortfolioPositions = usePortfolioPositions;
const react_query_1 = require("react-query");
const portfolio_api_1 = require("../api/portfolio.api");
function usePortfolioPositions() {
    return (0, react_query_1.useQuery)(['portfolio-positions'], portfolio_api_1.listPortfolioPositions);
}

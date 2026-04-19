"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usePortfolioAllocation = usePortfolioAllocation;
const react_query_1 = require("react-query");
const portfolio_api_1 = require("../api/portfolio.api");
function usePortfolioAllocation() {
    return (0, react_query_1.useQuery)(['portfolio-allocation'], portfolio_api_1.getPortfolioAllocation);
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usePortfolioActions = usePortfolioActions;
const react_query_1 = require("react-query");
const portfolio_api_1 = require("../api/portfolio.api");
function usePortfolioActions() {
    return (0, react_query_1.useQuery)(["portfolioActions"], portfolio_api_1.listPortfolioActions);
}

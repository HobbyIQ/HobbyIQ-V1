"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usePortfolioPosition = usePortfolioPosition;
const react_query_1 = require("react-query");
const portfolio_api_1 = require("../api/portfolio.api");
function usePortfolioPosition(positionId) {
    return (0, react_query_1.useQuery)(['portfolio-position', positionId], () => (0, portfolio_api_1.getPortfolioPosition)(positionId), {
        enabled: !!positionId,
    });
}

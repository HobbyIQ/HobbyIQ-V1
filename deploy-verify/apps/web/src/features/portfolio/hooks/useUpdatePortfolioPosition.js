"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useUpdatePortfolioPosition = useUpdatePortfolioPosition;
const react_query_1 = require("react-query");
const portfolio_api_1 = require("../api/portfolio.api");
function useUpdatePortfolioPosition() {
    const queryClient = (0, react_query_1.useQueryClient)();
    return (0, react_query_1.useMutation)(({ positionId, patch }) => (0, portfolio_api_1.updatePortfolioPosition)(positionId, patch), {
        onSuccess: () => {
            queryClient.invalidateQueries(['portfolio-positions']);
            queryClient.invalidateQueries(['portfolio-summary']);
            queryClient.invalidateQueries(['portfolio-allocation']);
            queryClient.invalidateQueries(['portfolio-recommendations']);
        },
    });
}

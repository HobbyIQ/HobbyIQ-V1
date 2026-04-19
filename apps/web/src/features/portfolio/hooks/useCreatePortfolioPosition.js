"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useCreatePortfolioPosition = useCreatePortfolioPosition;
const react_query_1 = require("react-query");
const portfolio_api_1 = require("../api/portfolio.api");
function useCreatePortfolioPosition() {
    const queryClient = (0, react_query_1.useQueryClient)();
    return (0, react_query_1.useMutation)(portfolio_api_1.createPortfolioPosition, {
        onSuccess: () => {
            queryClient.invalidateQueries(['portfolio-positions']);
            queryClient.invalidateQueries(['portfolio-summary']);
            queryClient.invalidateQueries(['portfolio-allocation']);
            queryClient.invalidateQueries(['portfolio-recommendations']);
        },
    });
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useAlertActions = useAlertActions;
const react_query_1 = require("react-query");
const alerts_api_1 = require("../api/alerts.api");
function useAlertActions() {
    const queryClient = (0, react_query_1.useQueryClient)();
    const dismiss = (0, react_query_1.useMutation)((candidateId) => (0, alerts_api_1.dismissAlert)(candidateId), {
        onSuccess: () => queryClient.invalidateQueries(["alerts"]),
    });
    return { dismiss };
}

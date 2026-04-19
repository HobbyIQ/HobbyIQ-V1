"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useAlertSubscriptions = useAlertSubscriptions;
const react_query_1 = require("react-query");
const alerts_api_1 = require("../api/alerts.api");
function useAlertSubscriptions(entityType, entityKey) {
    return (0, react_query_1.useQuery)([
        "alertSubscriptions",
        entityType,
        entityKey,
    ], () => (0, alerts_api_1.listAlertSubscriptions)({ entityType, entityKey }));
}

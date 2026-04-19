"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useAlertsInbox = useAlertsInbox;
const react_query_1 = require("react-query");
const alerts_api_1 = require("../api/alerts.api");
function useAlertsInbox(filters) {
    return (0, react_query_1.useQuery)(["alerts", filters], () => (0, alerts_api_1.listAlerts)(filters));
}

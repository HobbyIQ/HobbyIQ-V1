"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listAlerts = listAlerts;
exports.listAlertSubscriptions = listAlertSubscriptions;
exports.createAlertSubscription = createAlertSubscription;
exports.updateAlertSubscription = updateAlertSubscription;
exports.dismissAlert = dismissAlert;
const client_1 = require("../../../services/api/client");
async function listAlerts(params) {
    return client_1.apiClient.get("/api/alerts", { params });
}
async function listAlertSubscriptions(params) {
    return client_1.apiClient.get("/api/alerts/subscriptions", { params });
}
async function createAlertSubscription(input) {
    return client_1.apiClient.post("/api/alerts/subscriptions", input);
}
async function updateAlertSubscription(subscriptionId, input) {
    return client_1.apiClient.patch(`/api/alerts/subscriptions/${subscriptionId}`, input);
}
async function dismissAlert(candidateId) {
    return client_1.apiClient.post(`/api/alerts/${candidateId}/dismiss`);
}

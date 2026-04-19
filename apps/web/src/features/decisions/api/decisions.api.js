"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDecision = getDecision;
const client_1 = require("../../../services/api/client");
async function getDecision(entityType, entityKey) {
    return client_1.apiClient.get(`/api/decision/${entityType}/${entityKey}`);
}

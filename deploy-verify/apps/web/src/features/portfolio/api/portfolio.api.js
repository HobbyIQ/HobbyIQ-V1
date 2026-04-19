"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPortfolioActions = listPortfolioActions;
const client_1 = require("../../../services/api/client");
async function listPortfolioActions() {
    return client_1.apiClient.get("/api/portfolio/actions");
}

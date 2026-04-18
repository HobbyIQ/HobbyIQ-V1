"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const diagnostics_service_1 = require("./diagnostics.service");
const provider_health_service_1 = require("../../services/reliability/provider-health.service");
const providerHealth = new provider_health_service_1.ProviderHealthService();
const diagnosticsService = new diagnostics_service_1.DiagnosticsService(providerHealth);
const router = (0, express_1.Router)();
router.get('/overview', async (req, res) => {
    const overview = await diagnosticsService.getOverview();
    res.json(overview);
});
// TODO: Add more endpoints for sync, snapshots, alerts, learning, imports, providers
exports.default = router;

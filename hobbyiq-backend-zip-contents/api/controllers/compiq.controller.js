"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compiqQuery = compiqQuery;
exports.compiqEstimate = compiqEstimate;
exports.compiqHealth = compiqHealth;
const compiq_service_1 = require("../../services/shared/compiq.service");
const mock_comp_provider_1 = require("../../services/mock/mock-comp-provider");
const compService = new compiq_service_1.CompIQService(new mock_comp_provider_1.MockCompProvider());
async function compiqQuery(req, res) {
    const result = await compService.query(req.body);
    res.json(result);
}
async function compiqEstimate(req, res) {
    const result = await compService.estimate(req.body);
    res.json(result);
}
function compiqHealth(req, res) {
    res.json({ success: true, status: 'ok', service: 'CompIQ' });
}

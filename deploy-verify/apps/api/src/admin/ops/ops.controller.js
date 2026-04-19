"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const ops_service_1 = require("./ops.service");
const opsService = new ops_service_1.OpsService();
const router = (0, express_1.Router)();
router.post('/sync/:provider', async (req, res) => {
    const provider = req.params.provider;
    const result = await opsService.triggerProviderSync(provider);
    res.json(result);
});
router.post('/refresh/:entityType', async (req, res) => {
    const entityType = req.params.entityType;
    const result = await opsService.triggerSnapshotRefresh(entityType);
    res.json(result);
});
router.post('/learning/run', async (req, res) => {
    const result = await opsService.triggerLearningRun();
    res.json(result);
});
router.post('/imports/:batchId/retry', async (req, res) => {
    const batchId = Array.isArray(req.params.batchId) ? req.params.batchId[0] : req.params.batchId;
    const result = await opsService.retryImportBatch(batchId);
    res.json(result);
});
router.post('/seed-demo-data', async (req, res) => {
    const result = await opsService.seedDemoData();
    res.json(result);
});
exports.default = router;

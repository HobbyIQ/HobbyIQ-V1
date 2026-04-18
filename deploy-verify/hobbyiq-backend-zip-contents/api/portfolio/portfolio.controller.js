"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPortfolioController = createPortfolioController;
const express_1 = require("express");
function createPortfolioController(service) {
    const router = (0, express_1.Router)();
    // GET /api/portfolio
    router.get('/', async (req, res) => {
        const userId = req.user.id;
        const positions = await service.position.listPositions(userId);
        // TODO: Enrich with metrics/action plan
        res.json(positions);
    });
    // GET /api/portfolio/summary
    router.get('/summary', async (req, res) => {
        const userId = req.user.id;
        const positions = await service.position.listPositions(userId);
        const fullPositions = positions.map(p => ({
            ...p,
            quantity: p.quantity ?? 0,
            averageCost: p.averageCost ?? null,
            totalCostBasis: null,
            currentModeledValue: null,
            currentTotalValue: null,
            unrealizedGainLoss: null,
            unrealizedGainLossPct: null,
            convictionTag: p.convictionTag ?? null,
            notes: null,
        }));
        const summary = service.summary.computeSummary(userId, fullPositions);
        res.json(summary);
    });
    // GET /api/portfolio/allocation
    router.get('/allocation', async (req, res) => {
        const userId = req.user.id;
        const positions = await service.position.listPositions(userId);
        const fullPositions = positions.map(p => ({
            ...p,
            quantity: p.quantity ?? 0,
            averageCost: p.averageCost ?? null,
            totalCostBasis: null,
            currentModeledValue: null,
            currentTotalValue: null,
            unrealizedGainLoss: null,
            unrealizedGainLossPct: null,
            convictionTag: p.convictionTag ?? null,
            notes: null,
        }));
        const allocation = service.allocation.computeAllocation(userId, fullPositions);
        res.json(allocation);
    });
    // GET /api/portfolio/exposure
    router.get('/exposure', async (req, res) => {
        const userId = req.user.id;
        const positions = await service.position.listPositions(userId);
        const fullPositions = positions.map(p => ({
            ...p,
            quantity: p.quantity ?? 0,
            averageCost: p.averageCost ?? null,
            totalCostBasis: null,
            currentModeledValue: null,
            currentTotalValue: null,
            unrealizedGainLoss: null,
            unrealizedGainLossPct: null,
            convictionTag: p.convictionTag ?? null,
            notes: null,
        }));
        const exposure = service.exposure.computeExposure(userId, fullPositions);
        res.json(exposure);
    });
    // GET /api/portfolio/:positionId
    router.get('/:positionId', async (req, res) => {
        const userId = req.user.id;
        const positionId = Array.isArray(req.params.positionId) ? req.params.positionId[0] : req.params.positionId;
        const position = await service.position.getPosition(positionId, userId);
        if (!position)
            return res.status(404).json({ error: 'Not found' });
        res.json(position);
    });
    // POST /api/portfolio
    router.post('/', async (req, res) => {
        const userId = req.user.id;
        try {
            const position = await service.position.createPosition({ ...req.body, userId });
            res.status(201).json(position);
        }
        catch (e) {
            res.status(400).json({ error: e.message });
        }
    });
    // PATCH /api/portfolio/:positionId
    router.patch('/:positionId', async (req, res) => {
        const userId = req.user.id;
        try {
            const positionId = Array.isArray(req.params.positionId) ? req.params.positionId[0] : req.params.positionId;
            const position = await service.position.updatePosition(positionId, userId, req.body);
            res.json(position);
        }
        catch (e) {
            res.status(400).json({ error: e.message });
        }
    });
    // DELETE /api/portfolio/:positionId
    router.delete('/:positionId', async (req, res) => {
        const userId = req.user.id;
        const positionId = Array.isArray(req.params.positionId) ? req.params.positionId[0] : req.params.positionId;
        await service.position.deletePosition(positionId, userId);
        res.status(204).send();
    });
    // POST /api/portfolio/import
    router.post('/import', async (req, res) => {
        const userId = req.user.id;
        const result = await service.importService.importPositions(userId, req.body.positions);
        res.json(result);
    });
    // GET /api/portfolio/:positionId/action-plan
    router.get('/:positionId/action-plan', async (req, res) => {
        const userId = req.user.id;
        const positionId = Array.isArray(req.params.positionId) ? req.params.positionId[0] : req.params.positionId;
        const position = await service.position.getPosition(positionId, userId);
        if (!position)
            return res.status(404).json({ error: 'Not found' });
        // TODO: Compute metrics and action plan
        res.json({});
    });
    return router;
}

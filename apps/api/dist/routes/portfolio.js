"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const service_1 = require("../portfolio/service");
const router = (0, express_1.Router)();
// GET /api/portfolio
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
router.get("/", async (req, res) => {
    const userId = req.query.userId || "user-uuid";
    try {
        const portfolios = await prisma.portfolio.findMany({ where: { userId } });
        res.json({ success: true, data: portfolios });
    }
    catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch portfolios" });
    }
});
// GET /api/portfolio/:id
router.get("/:id", async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await (0, service_1.getPortfolio)(id);
    res.json(result);
});
// POST /api/portfolio
router.post("/", async (req, res) => {
    const result = await (0, service_1.createPortfolio)(req.body);
    res.json(result);
});
// POST /api/portfolio/:id/cards
router.post("/:id/cards", async (req, res) => {
    // TEMP: single-user assumption
    const userId = req.body.userId || "user-uuid";
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await (0, service_1.addPortfolioCard)(userId, id, req.body);
    res.json(result);
});
// PATCH /api/portfolio/cards/:cardId
router.patch("/cards/:cardId", async (req, res) => {
    const cardId = Array.isArray(req.params.cardId) ? req.params.cardId[0] : req.params.cardId;
    const result = await (0, service_1.updatePortfolioCard)(cardId, req.body);
    res.json(result);
});
// DELETE /api/portfolio/cards/:cardId
router.delete("/cards/:cardId", async (req, res) => {
    const cardId = Array.isArray(req.params.cardId) ? req.params.cardId[0] : req.params.cardId;
    const result = await (0, service_1.deletePortfolioCard)(cardId);
    res.json(result);
});
// POST /api/portfolio/:id/refresh
router.post("/:id/refresh", async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await (0, service_1.refreshPortfolio)(id);
    res.json(result);
});
// GET /api/portfolio/:id/summary
router.get("/:id/summary", async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await (0, service_1.getPortfolioSummary)(id);
    res.json(result);
});
exports.default = router;

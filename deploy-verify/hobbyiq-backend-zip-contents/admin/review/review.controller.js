"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const review_service_1 = require("./review.service");
const reviewService = new review_service_1.ReviewService();
const router = (0, express_1.Router)();
router.get('/', async (req, res) => {
    const type = req.query.type;
    const items = await reviewService.listReviewItems(type);
    res.json(items);
});
exports.default = router;

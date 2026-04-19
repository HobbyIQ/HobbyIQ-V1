"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const notification_1 = require("../services/notification");
const router = (0, express_1.Router)();
// GET /api/notifications
router.get("/notifications", (_req, res) => {
    // In production, use userId from auth/session
    const notifications = (0, notification_1.getNotifications)("demo");
    res.json({ notifications });
});
exports.default = router;

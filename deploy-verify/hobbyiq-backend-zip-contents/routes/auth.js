"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const service_1 = require("../services/auth/service");
const router = (0, express_1.Router)();
// POST /api/auth/signup
router.post("/signup", async (req, res) => {
    const { email, password } = req.body;
    const result = await (0, service_1.signUp)(email, password);
    if (!result.success)
        return res.status(400).json(result);
    res.json(result);
});
// POST /api/auth/signin
router.post("/signin", async (req, res) => {
    const { email, password } = req.body;
    const result = await (0, service_1.signIn)(email, password);
    if (!result.success)
        return res.status(400).json(result);
    res.json(result);
});
// POST /api/auth/signout
router.post("/signout", async (req, res) => {
    const sessionId = req.headers["x-session-id"] || req.cookies?.sessionId;
    if (!sessionId)
        return res.status(400).json({ success: false, error: "Missing sessionId" });
    const result = await (0, service_1.signOut)(sessionId);
    res.json(result);
});
// GET /api/auth/session
router.get("/session", async (req, res) => {
    const sessionId = req.headers["x-session-id"] || req.cookies?.sessionId;
    if (!sessionId)
        return res.status(401).json({ success: false, error: "Missing sessionId" });
    const user = await (0, service_1.getUserBySession)(sessionId);
    if (!user)
        return res.status(401).json({ success: false, error: "Invalid session" });
    res.json({ success: true, user });
});
exports.default = router;

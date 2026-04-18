"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireSession = requireSession;
const service_1 = require("./service");
async function requireSession(req, res, next) {
    const sessionId = req.headers["x-session-id"] || req.cookies?.sessionId;
    if (!sessionId)
        return res.status(401).json({ success: false, error: "Not authenticated" });
    const session = await (0, service_1.getSession)(sessionId);
    if (!session)
        return res.status(401).json({ success: false, error: "Invalid session" });
    req.sessionId = sessionId;
    req.userId = session.userId;
    next();
}

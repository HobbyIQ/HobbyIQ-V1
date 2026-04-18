"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mockAuth = mockAuth;
const userRepository_1 = require("../repositories/userRepository");
// Mock auth middleware: attaches user object to req
function mockAuth(req, res, next) {
    try {
        const userId = req.headers["x-user-id"] || req.query.userId || req.body.userId || "mock-user";
        const user = (0, userRepository_1.getUserById)(userId) || (0, userRepository_1.getUserById)("mock-user");
        if (!user) {
            return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "User not authenticated" } });
        }
        req.user = user;
        next();
    }
    catch (err) {
        res.status(500).json({ success: false, error: { code: "INTERNAL_SERVER_ERROR", message: err?.message || "Unexpected error" } });
    }
}

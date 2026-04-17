"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyticsLogger = analyticsLogger;
function analyticsLogger(req, res, next) {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[Analytics] ${req.method} ${req.originalUrl} - ${res.statusCode} - ${duration}ms`);
    });
    next();
}

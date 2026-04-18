"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestLogger = requestLogger;
exports.logError = logError;
function requestLogger(req, res, next) {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} (${duration}ms)`);
    });
    next();
}
function logError(err, req, res, next) {
    console.error(`[${new Date().toISOString()}] ERROR in ${req.method} ${req.originalUrl}:`, err);
    next(err);
}

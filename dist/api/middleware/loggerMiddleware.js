"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestLogger = requestLogger;
exports.logError = logError;
// Logs each request path and method
function requestLogger(req, res, next) {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        // Log method, path, status code, and duration
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} (${duration}ms)`);
    });
    next();
}
// Logs errors in handlers
function logError(err, req, res, next) {
    console.error(`[${new Date().toISOString()}] ERROR in ${req.method} ${req.originalUrl}:`, err);
    next(err);
}

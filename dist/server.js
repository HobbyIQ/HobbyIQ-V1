"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const compression_1 = __importDefault(require("compression"));
const brainRoutes_1 = __importDefault(require("./api/routes/brainRoutes"));
const outcomeRoutes_1 = __importDefault(require("./api/routes/outcomeRoutes"));
const brainOrchestratorRoutes_1 = __importDefault(require("./api/routes/brainOrchestratorRoutes"));
const fullAnalysisRoutes_1 = __importDefault(require("./api/routes/fullAnalysisRoutes"));
const deepHealthRoutes_1 = __importDefault(require("./api/routes/deepHealthRoutes"));
const rateLimitMiddleware_1 = require("./api/middleware/rateLimitMiddleware");
const analyticsMiddleware_1 = require("./api/middleware/analyticsMiddleware");
const featureFlags_1 = require("./config/featureFlags");
const envValidation_1 = require("./config/envValidation");
// Validate environment config at startup
(0, envValidation_1.validateEnv)(process.env);
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use((0, compression_1.default)());
app.use(rateLimitMiddleware_1.apiRateLimiter);
app.use(analyticsMiddleware_1.analyticsLogger);
// Log each request and status code
const loggerMiddleware_1 = require("./api/middleware/loggerMiddleware");
app.use(loggerMiddleware_1.requestLogger);
// Log server startup
console.log('--- HobbyIQ Backend Starting ---');
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
// Robust health endpoint
app.get('/api/brain/health', (req, res) => {
    res.json({ status: 'MCP HobbyIQ Brain running', success: true });
});
// Legacy health endpoint for compatibility
app.get('/api/health', (req, res) => {
    res.json({ status: 'HobbyIQ running', success: true });
});
// Deep health endpoint
if (featureFlags_1.featureFlags.enableDeepHealth) {
    app.use('/api/brain', deepHealthRoutes_1.default);
}
// MCP HobbyIQ Brain routes
app.use('/api/brain', (req, res, next) => {
    try {
        next();
    }
    catch (err) {
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});
app.use('/api/brain', brainRoutes_1.default);
app.use('/api/brain', outcomeRoutes_1.default);
app.use('/api/brain', fullAnalysisRoutes_1.default);
if (featureFlags_1.featureFlags.enableFullAnalysis) {
    app.use('/api/brain', brainOrchestratorRoutes_1.default);
}
// Catch-all for 404s
app.use((req, res, next) => {
    res.status(404).json({ success: false, error: 'Not found' });
});
// Log errors in handlers
app.use(loggerMiddleware_1.logError);
// Centralized error handler
app.use((err, req, res, next) => {
    // Defensive: never let logging crash the app
    try {
        console.error('Global error:', err);
    }
    catch (e) { }
    res.status(500).json({ success: false, error: err?.message || 'Internal server error' });
});
const port = parseInt(process.env.PORT || '8080', 10);
const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on 0.0.0.0:${port}`);
});
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use. Please stop the other process or set a different PORT.`);
        process.exit(1);
    }
    else {
        console.error('Server error:', err);
        process.exit(1);
    }
});

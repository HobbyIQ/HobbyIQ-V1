// Application Insights MUST be initialized before any other require()
// to ensure full automatic instrumentation of HTTP, Cosmos, Redis calls.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  try {
    const appInsights = require('applicationinsights');
    appInsights
      .setup(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)
      .setAutoCollectRequests(true)
      .setAutoCollectPerformance(true)
      .setAutoCollectExceptions(true)
      .setAutoCollectDependencies(true)
      .setAutoCollectConsole(true, true)
      .setSendLiveMetrics(true)
      .start();
    console.log('[AppInsights] Telemetry active');
  } catch (err) {
    console.warn('[AppInsights] Init failed:', err.message);
  }
}

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const { logger, requestLogger } = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');

dotenv.config();

const app = express();

// Rate limiting — 200 req/min per IP (generous for legitimate users, blocks bots)
try {
  const rateLimit = require('express-rate-limit');
  app.use('/api/', rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests, please slow down.' },
  }));
} catch {
  logger.warn('[RateLimit] express-rate-limit not installed, skipping');
}

app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(requestLogger);
app.use('/uploads', express.static(path.join(process.cwd(), '.data', 'uploads')));

console.log('--- HobbyIQ Backend Starting ---');
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

const PORT = process.env.PORT || 8080;

// Health endpoint — reports status of all downstream services
app.get('/api/health', (req, res) => {
  const { isRedisReady } = require('./services/cacheService');
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      redis: isRedisReady() ? 'connected' : 'fallback',
      cosmos: !!process.env.COSMOS_ENDPOINT ? 'configured' : 'fallback',
      appInsights: !!process.env.APPLICATIONINSIGHTS_CONNECTION_STRING ? 'active' : 'off',
    },
  });
});
app.get('/api/compiq/health', (req, res) => res.json({ status: 'HobbyIQ running' }));
app.get('/api/playeriq/health', (req, res) => res.json({ status: 'HobbyIQ running' }));

// Feature routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/compiq', require('./routes/compiq'));
app.use('/api/playeriq', require('./routes/playeriq'));
app.use('/api/dailyiq', require('./routes/dailyiq'));
app.use('/api/portfolio', require('./routes/portfolio'));
app.use('/api/uploads', require('./routes/uploads'));
app.use('/api/internal/ocr', require('./routes/ocr'));
app.use('/api/ebay', require('./routes/ebay'));
app.use('/api/ebay', require('./dist/routes/ebay.routes').default);
app.use('/api/alerts', require('./routes/alerts'));
app.use('/api/watchlist', require('./routes/watchlist'));

// Centralized error handler
app.use(errorHandler);

try {
  app.listen(PORT, () => {
    logger.info(`HobbyIQ backend running on port ${PORT}`);
  });
} catch (err) {
  logger.error('[FATAL] Failed to start server:', err);
}

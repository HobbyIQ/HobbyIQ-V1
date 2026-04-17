import express from 'express';
import cors from 'cors';
import compression from 'compression';
import brainRoutes from './api/routes/brainRoutes';
import outcomeRoutes from './api/routes/outcomeRoutes';
import brainOrchestratorRoutes from './api/routes/brainOrchestratorRoutes';
import fullAnalysisRoutes from './api/routes/fullAnalysisRoutes';
import deepHealthRoutes from './api/routes/deepHealthRoutes';
import { apiRateLimiter } from './api/middleware/rateLimitMiddleware';
import { errorHandler } from './api/middleware/errorHandlerMiddleware';
import { analyticsLogger } from './api/middleware/analyticsMiddleware';
import { featureFlags } from './config/featureFlags';
import { validateEnv } from './config/envValidation';

// Validate environment config at startup
validateEnv(process.env);



const app = express();
app.use(cors());
app.use(express.json());
app.use(compression());
app.use(apiRateLimiter);
app.use(analyticsLogger);

// Log each request and status code
import { requestLogger, logError } from './api/middleware/loggerMiddleware';
app.use(requestLogger);

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
if (featureFlags.enableDeepHealth) {
  app.use('/api/brain', deepHealthRoutes);
}

// MCP HobbyIQ Brain routes
app.use('/api/brain', (req, res, next) => {
  try {
    next();
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});
app.use('/api/brain', brainRoutes);
app.use('/api/brain', outcomeRoutes);
app.use('/api/brain', fullAnalysisRoutes);
if (featureFlags.enableFullAnalysis) {
  app.use('/api/brain', brainOrchestratorRoutes);
}

// Catch-all for 404s
app.use((req, res, next) => {
  res.status(404).json({ success: false, error: 'Not found' });
});


// Log errors in handlers
app.use(logError);
// Centralized error handler
app.use((err, req, res, next) => {
  // Defensive: never let logging crash the app
  try {
    console.error('Global error:', err);
  } catch (e) {}
  res.status(500).json({ success: false, error: err?.message || 'Internal server error' });
});


const port = parseInt(process.env.PORT || '8080', 10);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on 0.0.0.0:${port}`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Please stop the other process or set a different PORT.`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

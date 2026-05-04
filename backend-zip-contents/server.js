const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { logger, requestLogger } = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(requestLogger);

console.log('--- HobbyIQ Backend Starting ---');
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

['PORT', 'API_KEY_EXAMPLE'].forEach((key) => {
  if (!process.env[key]) logger.warn(`[WARN] Missing env var: ${key}`);
});

const PORT = process.env.PORT || 8080;

// Health endpoints
app.get('/api/health', (req, res) => res.json({ status: 'HobbyIQ running' }));
app.get('/api/compiq/health', (req, res) => res.json({ status: 'HobbyIQ running' }));
app.get('/api/playeriq/health', (req, res) => res.json({ status: 'HobbyIQ running' }));

// Feature routes
if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
  // Use TypeScript source for dev/test
  (async () => {
    const compiqRouter = (await import('./src/routes/compiq')).default;
    app.use('/api/compiq', compiqRouter);
  })();
} else {
  // Use compiled JS for production
  app.use('/api/compiq', require('./routes/compiq'));
}
app.use('/api/playeriq', require('./routes/playeriq'));
app.use('/api/dailyiq', require('./routes/dailyiq'));

// Centralized error handler
app.use(errorHandler);

if (require.main === module) {
  try {
    app.listen(PORT, () => {
      logger.info(`HobbyIQ backend running on port ${PORT}`);
    });
  } catch (err) {
    logger.error('[FATAL] Failed to start server:', err);
  }
}

module.exports = app;

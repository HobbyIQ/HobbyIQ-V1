import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { logger, requestLogger } from './utils/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import compiqRouter from './routes/compiq.js';
import playeriqRouter from './routes/playeriq.js';
import dailyiqRouter from './routes/dailyiq.js';

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

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// Health endpoints
app.get('/api/health', (req: any, res: any) => res.json({ status: 'HobbyIQ running' }));
app.get('/api/compiq/health', (req: any, res: any) => res.json({ status: 'HobbyIQ running' }));
app.get('/api/playeriq/health', (req: any, res: any) => res.json({ status: 'HobbyIQ running' }));

// Feature routes
app.use('/api/compiq', compiqRouter);
app.use('/api/playeriq', playeriqRouter);
app.use('/api/dailyiq', dailyiqRouter);

// Centralized error handler
app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  try {
    app.listen(PORT, () => {
      logger.info(`HobbyIQ backend running on port ${PORT}`);
    });
  } catch (err) {
    logger.error('Failed to start server:', err);
  }
}

export default app;

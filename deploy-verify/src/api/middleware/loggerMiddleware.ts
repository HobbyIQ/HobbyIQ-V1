import { Request, Response, NextFunction } from 'express';

// Logs each request path and method
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    // Log method, path, status code, and duration
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} (${duration}ms)`);
  });
  next();
}

// Logs errors in handlers
export function logError(err: any, req: Request, res: Response, next: NextFunction) {
  console.error(`[${new Date().toISOString()}] ERROR in ${req.method} ${req.originalUrl}:`, err);
  next(err);
}

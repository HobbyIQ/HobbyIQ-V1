import { Request, Response, NextFunction } from 'express';

export function analyticsLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[Analytics] ${req.method} ${req.originalUrl} - ${res.statusCode} - ${duration}ms`);
  });
  next();
}

export const logger = {
  info: (...args: any[]) => console.log('[INFO]', ...args),
  warn: (...args: any[]) => console.warn('[WARN]', ...args),
  error: (...args: any[]) => console.error('[ERROR]', ...args)
};

import { Request, Response, NextFunction } from 'express';
export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  logger.info(req.method, req.originalUrl);
  next();
};

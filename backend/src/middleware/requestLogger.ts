import { Request, Response, NextFunction } from "express";

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  if (process.env.NODE_ENV !== "production") {
    console.log(`[${req.method}] ${req.originalUrl}`);
  }
  next();
}

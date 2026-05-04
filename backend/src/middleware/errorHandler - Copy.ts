import { Request, Response, NextFunction } from "express";

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  const code = err.code || "INTERNAL_ERROR";
  const status = err.status || 500;
  const message = process.env.NODE_ENV === "production" && status === 500
    ? "An unexpected error occurred."
    : err.message || "Unknown error";
  res.status(status).json({ error: { message, code } });
}

export function notFoundHandler(req: Request, res: Response, next: NextFunction) {
  res.status(404).json({ error: { message: "Route not found", code: "NOT_FOUND" } });
}

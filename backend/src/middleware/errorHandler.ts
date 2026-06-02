import { Request, Response, NextFunction } from 'express';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
}

/**
 * Top-level Express error handler.
 *
 * CF-LAUNCH-HARDENING P2 (2026-06-02): only 4xx errors pass the original
 * `err.message` through to the client; 5xx errors emit a generic
 * "Internal Server Error" to avoid leaking implementation detail (file
 * paths, SQL fragments, stack traces, upstream-API error strings, etc.)
 * to iOS / public clients. The real message stays in stderr / App
 * Insights via the request logger + the standard Node error pipeline
 * for debugging.
 *
 * Pattern is conservative-by-default: anything not explicitly a 4xx
 * status (including the `err.status` unset case → 500) returns the
 * generic copy. A status in [400, 500) is treated as "this is a client-
 * facing message" and passes through (e.g. validation errors).
 *
 * Routes that need a SPECIFIC 5xx user-facing message (e.g.
 * "Couldn't reach the catalog in time") should emit it themselves
 * with res.status(2xx).json(...) — see upstreamTimeout.helpers.ts for
 * the pattern. The error handler is the safety net, not the surface.
 */
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  const status = typeof err?.status === "number" ? err.status : 500;
  const safeMessage =
    status >= 400 && status < 500
      ? err?.message || "Bad Request"
      : "Internal Server Error";
  res.status(status).json({ error: safeMessage });
}

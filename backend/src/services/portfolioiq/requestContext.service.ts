// CF-REQUEST-CONTEXT (Drew, 2026-07-23, issue #722 signals phase 2).
// Per-request context so vendor client hooks can attribute persistence
// events to the authenticated user WITHOUT threading userId through
// every function signature.
//
// Uses Node's AsyncLocalStorage. Populated by middleware after
// requireSession; read by persistUserQuerySignalsInBackground so the
// market_signals container captures anonymized userId (SHA-256 with
// daily salt — see persistUserQuerySignals.service.ts).
//
// Standalone from requireSession — vendor client functions don't have
// access to `req.user`, and threading it through would touch every
// call site.

import { AsyncLocalStorage } from "async_hooks";
import type { Request, Response, NextFunction } from "express";

interface RequestContext {
  userId: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Read the current request's userId from AsyncLocalStorage. Null when
 *  called outside a request-scoped context (e.g. cron jobs). */
export function getCurrentUserId(): string | null {
  return storage.getStore()?.userId ?? null;
}

/** Set the current request's userId. Called by requireSession AFTER
 *  it resolves req.user. Safe no-op when there's no active context
 *  (e.g. cron jobs never enter the middleware). */
export function setCurrentUserId(userId: string | null): void {
  const store = storage.getStore();
  if (store) store.userId = userId;
}

/** Express middleware: read userId from req.user (set by requireSession)
 *  and stash it in AsyncLocalStorage for the remainder of the request.
 *  Mount AFTER requireSession, BEFORE route handlers. */
export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const userId = (req as unknown as { user?: { userId?: string; id?: string } }).user?.userId
              ?? (req as unknown as { user?: { userId?: string; id?: string } }).user?.id
              ?? null;
  storage.run({ userId }, () => next());
}

/** Testing helper — run a callback with an explicit context. */
export function runWithUserId<T>(userId: string | null, fn: () => T): T {
  return storage.run({ userId }, fn);
}

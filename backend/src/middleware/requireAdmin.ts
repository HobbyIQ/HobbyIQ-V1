// CF-ADMIN-AUTH (2026-07-08, Drew): simple bearer-token gate for
// admin-only routes. Reads ADMIN_API_TOKEN from env (set in App
// Service application settings), never echoed. Any request without
// a matching Authorization header returns 401.
//
// This is a first-pass admin gate. When we grow multiple admin users
// or per-user permissions, migrate to a role field on the User doc
// + session-driven checks. For now, one shared token gets the alias
// admin surface online without new user infrastructure.

import type { Request, Response, NextFunction } from "express";

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const configuredToken = process.env.ADMIN_API_TOKEN;
  if (!configuredToken) {
    res.status(503).json({
      success: false,
      error: "Admin routes disabled: ADMIN_API_TOKEN not configured",
    });
    return;
  }
  const header = req.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : "";
  if (!provided) {
    res.status(401).json({ success: false, error: "Missing Authorization: Bearer <token>" });
    return;
  }
  // Timing-safe equality via length + character loop. Short strings
  // + occasional admin traffic mean full crypto compare isn't required
  // here, but avoid the trivial != short-circuit.
  const a = Buffer.from(provided);
  const b = Buffer.from(configuredToken);
  if (a.length !== b.length) {
    res.status(401).json({ success: false, error: "Invalid admin token" });
    return;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) {
    res.status(401).json({ success: false, error: "Invalid admin token" });
    return;
  }
  next();
}

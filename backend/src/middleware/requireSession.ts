// CF-PAYMENTS-A (2026-06-02): requireSession middleware.
//
// Validates x-session-id, looks up the user via getUserBySession, attaches
// req.user (typed AuthUser including `plan`). 401 on absent/invalid.
//
// Replaces the inline `resolveUser` / `requireUserId` / `requireSessionUser`
// helpers that were repeated across 10 route files. Each retrofitted route
// declares `requireSession` either at router-level (router.use) or per-
// endpoint, depending on whether all sibling routes need auth.
//
// CF-TIER1-HARNESS-TOKEN-BYPASS (2026-06-30): the Tier 1 Production
// Harness in CI needs to hit /api/compiq/* endpoints without a real
// user session. When the backend env var TIER1_HARNESS_TOKEN is set
// AND the inbound x-session-id matches it exactly, authenticate as
// a synthetic harness user with plan=pro_seller (so entitlement
// gates don't block test cases). Fail-closed by design: if the env
// var is unset OR empty, the bypass is unreachable. The matching
// value also lives as a GitHub Secret (TIER1_HARNESS_SESSION_ID) the
// harness sends as x-session-id. See backend/docs/runbooks/tier1-
// harness-session.md.

import type { Request, Response, NextFunction } from "express";
import { getUserBySession, type AuthUser } from "../services/authService.js";

/** Synthetic user for the Tier 1 harness bypass. Stable userId so
 *  telemetry can filter harness traffic; clearly identifiable email so
 *  no real-user assumption travels downstream. */
const HARNESS_USER: AuthUser = {
  userId: "tier1-harness",
  email: "tier1-harness@hobbyiq.internal",
  plan: "pro_seller",  // top tier so entitlement gates pass
  createdAt: "2026-06-30T00:00:00.000Z",
};

export async function requireSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // If a previous instance of requireSession already attached a user (e.g.
  // multiple mounts under different path prefixes), short-circuit.
  if (req.user) {
    next();
    return;
  }

  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) {
    res.status(401).json({ success: false, error: "Missing or invalid x-session-id header" });
    return;
  }

  // CF-TIER1-HARNESS-TOKEN-BYPASS: short-circuit BEFORE the session lookup
  // when the value matches the configured harness token. Fail-closed:
  // requires the env var to be set AND non-empty. The == is exact-string;
  // there's no prefix or HMAC scheme — the token is a CI-only shared
  // secret, not a user-facing credential.
  const harnessToken = process.env.TIER1_HARNESS_TOKEN ?? "";
  if (harnessToken.length > 0 && sessionId === harnessToken) {
    req.user = HARNESS_USER;
    next();
    return;
  }

  const user = await getUserBySession(sessionId);
  if (!user) {
    res.status(401).json({ success: false, error: "Missing or invalid x-session-id header" });
    return;
  }

  req.user = user;
  next();
}

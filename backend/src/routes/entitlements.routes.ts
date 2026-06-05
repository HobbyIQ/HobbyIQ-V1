// CF-PAYMENTS-A (2026-06-02): GET /api/entitlements/me.
//
// Returns the caller's plan + the full resolved entitlement matrix (features
// + caps) so iOS can drive proactive UI gating (greyed-out buttons, "Pro
// only" badges) without polling per-feature endpoints. The backend ALWAYS
// re-checks via requireEntitlement / requireCapacity middleware on every
// gated route — this endpoint is presentation hints only.

import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import {
  effectivePlanFor,
  resolveEntitlementsFor,
} from "../config/entitlements.js";

const router = Router();

router.get("/me", requireSession, (req: Request, res: Response) => {
  // requireSession guarantees req.user is present.
  // CF-OWNER-OVERRIDE (2026-06-05): resolve EFFECTIVE plan so iOS sees
  // the comped tier in the UI matrix — same helper every enforcement
  // middleware uses, so display + access can't drift.
  const effective = effectivePlanFor(req.user!);
  const resolved = resolveEntitlementsFor(effective);
  res.json({ success: true, ...resolved });
});

export default router;

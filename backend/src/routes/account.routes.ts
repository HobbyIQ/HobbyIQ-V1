// CF-ACCOUNT-DELETION (2026-06-04): DELETE /api/account.
//
// Apple Guideline 5.1.1(v): apps with account creation must offer in-app
// deletion. This route is the backend path the iOS "Delete Account" button
// calls. iOS layers a confirmation modal on top; the backend's defense
// against accidental fires is the required `{ confirm: "DELETE_MY_ACCOUNT" }`
// body.

import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import { deleteAccountForUser } from "../services/accountDeletion/accountDeletion.service.js";

const router = Router();

router.use(requireSession);

const CONFIRMATION_TOKEN = "DELETE_MY_ACCOUNT";

router.delete("/", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { confirm?: unknown };
  if (typeof body.confirm !== "string" || body.confirm !== CONFIRMATION_TOKEN) {
    res.status(400).json({
      success: false,
      error: "Confirmation required",
      hint: `body must include {"confirm": "${CONFIRMATION_TOKEN}"} to prevent accidental deletion`,
    });
    return;
  }

  const user = req.user!;
  try {
    const result = await deleteAccountForUser(user);
    res.json(result);
  } catch (err: any) {
    console.error("[account.delete] orchestrator threw:", err?.message ?? err);
    res.status(500).json({ success: false, error: "Account deletion failed" });
  }
});

export default router;

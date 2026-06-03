// Routes: /api/psa/cert/:certNumber
// CF-PAYMENTS-A: requireSession enforced; no entitlement gate (cert lookups
// remain available on all plans so users can identify a slab they already
// have in front of them).

import { Request, Response, Router } from "express";
import { lookupPsaCertByNumber, PsaApiError } from "../services/psa/psaCert.service.js";
import { requireSession } from "../middleware/requireSession.js";

const router = Router();
router.use(requireSession);

router.get("/cert/:certNumber", async (req: Request, res: Response) => {
  const certNumber = String(req.params.certNumber ?? "").trim();
  if (!certNumber) {
    return res.status(400).json({ success: false, error: "certNumber is required" });
  }

  try {
    const result = await lookupPsaCertByNumber(certNumber);
    return res.json({ success: true, ...result });
  } catch (error: unknown) {
    if (error instanceof PsaApiError) {
      return res.status(error.status).json({
        success: false,
        error: error.message,
        code: error.code,
      });
    }

    const message = error instanceof Error ? error.message : "Unknown PSA error";
    return res.status(500).json({ success: false, error: message, code: "PSA_INTERNAL_ERROR" });
  }
});

export default router;

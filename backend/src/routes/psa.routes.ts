import { Request, Response, Router } from "express";
import { getUserBySession } from "../services/authService.js";
import { lookupPsaCertByNumber, PsaApiError } from "../services/psa/psaCert.service.js";

const router = Router();

async function requireSessionUser(req: Request, res: Response): Promise<boolean> {
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) {
    res.status(401).json({ success: false, error: "Missing x-session-id" });
    return false;
  }

  const user = await getUserBySession(sessionId);
  if (!user) {
    res.status(401).json({ success: false, error: "Invalid session" });
    return false;
  }

  return true;
}

router.get("/cert/:certNumber", async (req: Request, res: Response) => {
  const isAuthenticated = await requireSessionUser(req, res);
  if (!isAuthenticated) return;

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

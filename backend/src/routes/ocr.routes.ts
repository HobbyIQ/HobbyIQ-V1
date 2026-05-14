import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { getUserBySession } from "../services/authService.js";
import { extractCardCandidate } from "../services/ocr/cardOcr.service.js";

const router = Router();

function isEnabled(): boolean {
  return String(process.env.OCR_INTERNAL_ENABLED ?? "false").toLowerCase() === "true";
}

function hasInternalAccess(req: Request): boolean {
  const key = String(process.env.OCR_INTERNAL_KEY ?? "").trim();
  if (!key) return false;
  const provided = String(req.headers["x-internal-key"] ?? "").trim();
  return provided.length > 0 && provided === key;
}

async function resolveUser(req: Request, res: Response): Promise<{ userId: string } | null> {
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) {
    res.status(401).json({ success: false, error: "Missing x-session-id header" });
    return null;
  }
  const user = await getUserBySession(sessionId);
  if (!user) {
    res.status(401).json({ success: false, error: "Invalid or expired session" });
    return null;
  }
  return { userId: user.userId };
}

router.use((req: Request, res: Response, next) => {
  if (!isEnabled()) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  if (!hasInternalAccess(req)) {
    res.status(403).json({ success: false, error: "Forbidden" });
    return;
  }
  next();
});

router.post("/extract", async (req: Request, res: Response) => {
  const ctx = await resolveUser(req, res);
  if (!ctx) return;

  const frontText = String(req.body?.frontText ?? "");
  const backText = String(req.body?.backText ?? "");

  if (!frontText && !backText) {
    res.status(400).json({ success: false, error: "frontText or backText is required" });
    return;
  }

  const candidate = extractCardCandidate({ frontText, backText });
  res.json({
    success: true,
    mode: "text-parser-v1",
    candidate,
    nextStep: "Confirm/correct fields in internal tooling before user rollout",
  });
});

router.post("/training-example", async (req: Request, res: Response) => {
  const ctx = await resolveUser(req, res);
  if (!ctx) return;

  const payload = {
    userId: ctx.userId,
    createdAt: new Date().toISOString(),
    source: {
      frontImageUrl: req.body?.frontImageUrl ?? null,
      backImageUrl: req.body?.backImageUrl ?? null,
      frontText: req.body?.frontText ?? "",
      backText: req.body?.backText ?? "",
    },
    extracted: req.body?.extracted ?? null,
    corrected: req.body?.corrected ?? null,
    notes: req.body?.notes ?? null,
  };

  const dir = path.join(process.cwd(), ".data", "ocr-training");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${ctx.userId}.jsonl`);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");

  res.json({ success: true, saved: true });
});

export default router;

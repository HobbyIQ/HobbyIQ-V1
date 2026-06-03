// Routes: /api/internal/ocr/*
//
// CF-PAYMENTS-A retrofit: requireSession added after the existing internal-
// key + feature-flag gate. This is internal tooling for training-data
// collection; no user-facing entitlement gate (the internal-key gate is
// the operative auth surface). Sequence: feature-flag -> internal-key ->
// session.

import { Router, Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import { extractCardCandidate } from "../services/ocr/cardOcr.service.js";
import { requireSession } from "../middleware/requireSession.js";

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

router.use((req: Request, res: Response, next: NextFunction) => {
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

// Session is required AFTER the internal-key gate so a leaked key alone
// still can't masquerade as a user when writing training examples.
router.use(requireSession);

router.post("/extract", async (req: Request, res: Response) => {
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
  const userId = req.user!.userId;

  const payload = {
    userId,
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
  const filePath = path.join(dir, `${userId}.jsonl`);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");

  res.json({ success: true, saved: true });
});

export default router;

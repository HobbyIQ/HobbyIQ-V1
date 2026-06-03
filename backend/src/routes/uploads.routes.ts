// Routes: /api/uploads/card-photo
//
// CF-PAYMENTS-A: requireSession enforced; no entitlement gate at this layer.
// Scan-rate caps (scansPerMonth) attach to the downstream
// /api/portfolio/identify endpoint that actually consumes a scan, not to the
// blob upload which is also reused for benign holding-photo uploads.

import { Router, Request, Response } from "express";
import { issueSasUploadUrl } from "../services/photoStorage/photoStorage.service.js";
import { requireSession } from "../middleware/requireSession.js";

const router = Router();
router.use(requireSession);

const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp"]);

/**
 * POST /api/uploads/card-photo
 *
 * Issues a short-lived SAS upload URL scoped to a single blob in the
 * card-images container. The iOS client PUTs the image bytes directly to
 * {uploadUrl}, then stores {blobUrl} in the holding's photos[] array via
 * /api/portfolio/holdings.
 *
 * Body:    { clientId?: string, fileExtension?: "jpg"|"jpeg"|"png"|"webp" }
 * Returns: { success: true, uploadUrl, blobUrl, blobName, containerName,
 *            contentType, maxSizeBytes, expiresAt }
 */
router.post("/card-photo", async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const clientId = typeof req.body?.clientId === "string" ? req.body.clientId.trim() : undefined;
  const rawExt = typeof req.body?.fileExtension === "string" ? req.body.fileExtension.trim() : "jpg";
  const ext = rawExt.toLowerCase().replace(/^\./, "");

  if (!ALLOWED_EXT.has(ext)) {
    res.status(400).json({
      success: false,
      error: `Unsupported file extension. Allowed: ${Array.from(ALLOWED_EXT).join(", ")}`,
    });
    return;
  }

  try {
    const sas = await issueSasUploadUrl({
      userId,
      clientId,
      fileExtension: ext,
    });
    res.json({ success: true, ...sas });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to issue upload URL";
    console.error("[uploads/card-photo] SAS issuance failed:", err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;

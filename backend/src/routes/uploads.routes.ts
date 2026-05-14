import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getUserBySession } from "../services/authService.js";

const router = Router();

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

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

router.post("/card-photo", async (req: Request, res: Response) => {
  const ctx = await resolveUser(req, res);
  if (!ctx) return;

  const imageBase64 = String(req.body?.imageBase64 ?? "").trim();
  const rawMimeType = String(req.body?.mimeType ?? "image/jpeg").toLowerCase();
  const side = String(req.body?.side ?? "photo").toLowerCase();

  if (!imageBase64) {
    res.status(400).json({ success: false, error: "imageBase64 is required" });
    return;
  }

  const mimeType = MIME_TO_EXT[rawMimeType] ? rawMimeType : "image/jpeg";
  const ext = MIME_TO_EXT[mimeType];

  const payload = imageBase64.includes(",") ? imageBase64.split(",").pop() ?? "" : imageBase64;
  const buffer = Buffer.from(payload, "base64");

  if (!buffer.length) {
    res.status(400).json({ success: false, error: "Invalid base64 image payload" });
    return;
  }

  if (buffer.length > 8 * 1024 * 1024) {
    res.status(413).json({ success: false, error: "Image too large (max 8MB)" });
    return;
  }

  const safeSide = side === "front" || side === "back" ? side : "photo";
  const fileName = `${Date.now()}-${safeSide}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
  const userDir = path.join(process.cwd(), ".data", "uploads", ctx.userId);
  const absolutePath = path.join(userDir, fileName);

  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(absolutePath, buffer);

  const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol ?? "https");
  const host = String(req.headers["x-forwarded-host"] ?? req.get("host") ?? "");
  const publicBase = host ? `${proto}://${host}` : "";
  const relativeUrl = `/uploads/${encodeURIComponent(ctx.userId)}/${encodeURIComponent(fileName)}`;

  res.json({
    success: true,
    url: `${publicBase}${relativeUrl}`,
    path: relativeUrl,
    mimeType,
    size: buffer.length,
  });
});

export default router;

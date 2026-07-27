// CF-MESSAGING (Drew, 2026-07-27). All routes session-gated.
//
//   GET  /api/messages/threads
//   GET  /api/messages/threads/:otherUserId
//   POST /api/messages
//   POST /api/messages/:messageId/mark-sold?threadId=<t>
//   GET  /api/messages/unread-count
//
// The mark-sold route takes the threadId as a query param so we can
// point-read the offer message in Cosmos (partition-key required) —
// smaller latency than a cross-partition scan by id.

import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { requireSession } from "../middleware/requireSession.js";
import {
  listMessagesInThread,
  listThreads,
  markSold,
  sendMessage,
  unreadCountFor,
  type HoldingRef,
  type MessageKind,
} from "../services/messaging.service.js";

const router = Router();

const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many messages, slow down" },
});

router.get("/threads", requireSession, async (req: Request, res: Response) => {
  const summaries = await listThreads(req.user!.userId);
  return res.json({ success: true, threads: summaries });
});

router.get("/threads/:otherUserId", requireSession, async (req: Request, res: Response) => {
  const otherUserId = String(req.params.otherUserId ?? "").trim();
  if (!otherUserId) {
    return res.status(400).json({ success: false, error: "otherUserId required" });
  }
  const messages = await listMessagesInThread(req.user!.userId, otherUserId);
  return res.json({ success: true, messages });
});

router.post("/", requireSession, sendLimiter, async (req: Request, res: Response) => {
  const fromUserId = req.user!.userId;
  const toUserId = String(req.body?.toUserId ?? "").trim();
  const text = String(req.body?.text ?? "");
  const kindRaw = String(req.body?.kind ?? "chat");
  const kind: MessageKind =
    kindRaw === "offer" || kindRaw === "accepted" || kindRaw === "sold"
      ? kindRaw
      : "chat";
  const priceCents =
    typeof req.body?.priceCents === "number" && Number.isFinite(req.body.priceCents)
      ? Math.round(req.body.priceCents)
      : null;
  const holdingRefRaw = req.body?.holdingRef;
  const holdingRef: HoldingRef | null =
    holdingRefRaw && typeof holdingRefRaw === "object"
      ? {
          holdingId: String(holdingRefRaw.holdingId ?? ""),
          sellerUserId: String(holdingRefRaw.sellerUserId ?? ""),
          cardTitle: String(holdingRefRaw.cardTitle ?? ""),
          imageUrl:
            typeof holdingRefRaw.imageUrl === "string" ? holdingRefRaw.imageUrl : null,
          askingPriceCents:
            typeof holdingRefRaw.askingPriceCents === "number"
              ? holdingRefRaw.askingPriceCents
              : null,
        }
      : null;

  if (!toUserId) {
    return res.status(400).json({ success: false, error: "toUserId required" });
  }
  try {
    const record = await sendMessage({
      fromUserId,
      toUserId,
      text,
      kind,
      priceCents,
      holdingRef,
    });
    return res.json({ success: true, message: record });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Send failed";
    return res.status(400).json({ success: false, error: msg });
  }
});

router.post(
  "/:messageId/mark-sold",
  requireSession,
  async (req: Request, res: Response) => {
    const messageId = String(req.params.messageId ?? "").trim();
    const threadId = String(req.query.threadId ?? req.body?.threadId ?? "").trim();
    if (!messageId || !threadId) {
      return res.status(400).json({ success: false, error: "messageId + threadId required" });
    }
    const record = await markSold({
      actingUserId: req.user!.userId,
      threadId,
      offerMessageId: messageId,
    });
    if (!record) {
      return res.status(404).json({ success: false, error: "Offer not found or not authorized" });
    }
    return res.json({ success: true, message: record });
  },
);

router.get("/unread-count", requireSession, async (req: Request, res: Response) => {
  const n = await unreadCountFor(req.user!.userId);
  return res.json({ success: true, unread: n });
});

export default router;

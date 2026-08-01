// CF-FLAG-COMP (Drew, 2026-08-01). End-user "this looks wrong" endpoint
// for any sold_comps row shown in the app. Enqueues to verify_queue
// with reason=user-flagged so admins can review. Tracks flag count
// per row — after N distinct users flag the same row, we auto-mark
// __userFlagQuarantine=true on the row so downstream views can
// filter it out even before admin review.

import { Router, type Request, type Response, type NextFunction } from "express";
import { CosmosClient, type Container } from "@azure/cosmos";
import { getUserBySession } from "../services/authService.js";

const router = Router();

const AUTO_QUARANTINE_THRESHOLD = 3;

async function requireUser(req: Request, res: Response): Promise<{ userId: string } | null> {
  if (req.user?.userId) return { userId: req.user.userId };
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) { res.status(401).json({ error: "Missing x-session-id" }); return null; }
  const user = await getUserBySession(sessionId);
  if (!user) { res.status(401).json({ error: "Invalid session" }); return null; }
  return { userId: user.userId };
}

let cachedSc: Container | null = null;
async function getSoldComps(): Promise<Container | null> {
  if (cachedSc) return cachedSc;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  const client = new CosmosClient(conn);
  cachedSc = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");
  return cachedSc;
}

router.post("/user/flag-comp", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const b = req.body ?? {};
    const rowId = String(b.rowId ?? "").trim();
    const cardId = String(b.cardId ?? "").trim();
    const reasonNote = typeof b.reasonNote === "string" ? b.reasonNote.slice(0, 500) : null;
    const flagCategory = typeof b.category === "string" ? b.category : "generic";
    if (!rowId || !cardId) {
      res.status(400).json({ success: false, error: "rowId + cardId required" });
      return;
    }

    const sc = await getSoldComps();
    if (!sc) { res.status(503).json({ success: false, error: "Cosmos not configured" }); return; }

    // Fetch the row (partition key = cardId)
    let row: Record<string, unknown> | null = null;
    try {
      const { resource } = await sc.item(rowId, cardId).read();
      row = (resource as Record<string, unknown>) ?? null;
    } catch { row = null; }
    if (!row) {
      res.status(404).json({ success: false, error: "row not found" });
      return;
    }

    // Enqueue to verify_queue (best-effort — never block user response)
    void (async () => {
      try {
        const { enqueueForVerify } = await import("../services/portfolioiq/verifyQueue.service.js");
        await enqueueForVerify({
          reason: "user-flagged",
          saleInput: {
            cardId: (row as { cardId?: string }).cardId ?? cardId,
            playerName: String((row as { playerName?: string }).playerName ?? ""),
            cardYear: (row as { cardYear?: number | null }).cardYear ?? null,
            setName: (row as { setName?: string | null }).setName ?? null,
            parallel: (row as { parallel?: string | null }).parallel ?? null,
            cardNumber: (row as { cardNumber?: string | null }).cardNumber ?? null,
            isAuto: (row as { isAuto?: boolean }).isAuto ?? false,
            gradeCompany: (row as { gradeCompany?: string | null }).gradeCompany ?? null,
            gradeValue: (row as { gradeValue?: number | null }).gradeValue ?? null,
            price: Number((row as { price?: number }).price ?? 0),
            soldAt: String((row as { soldAt?: string }).soldAt ?? ""),
            source: (String((row as { source?: string }).source ?? "manual-user-entry") as "cardhedge" | "ebay-user-purchase" | "ebay-user-sale" | "manual-user-entry" | "ebay-browse-ended" | "cardsight"),
            title: (row as { title?: string | null }).title ?? null,
            imageUrl: (row as { imageUrl?: string | null }).imageUrl ?? null,
            url: null,
          },
          signal: { note: `user-flagged (${flagCategory})${reasonNote ? ": " + reasonNote : ""}` },
        });
      } catch { /* silent */ }
    })();

    // Track flag count on the row itself + auto-quarantine at threshold
    const currentFlags = Array.isArray((row as { __userFlags?: string[] }).__userFlags)
      ? [...((row as { __userFlags?: string[] }).__userFlags as string[])]
      : [];
    if (!currentFlags.includes(auth.userId)) currentFlags.push(auth.userId);
    const nextRow: Record<string, unknown> = { ...row, __userFlags: currentFlags, __lastUserFlagAt: new Date().toISOString() };
    if (currentFlags.length >= AUTO_QUARANTINE_THRESHOLD) {
      nextRow.__userFlagQuarantine = true;
      nextRow.__userFlagQuarantineAt = new Date().toISOString();
    }
    try { await sc.items.upsert(nextRow); } catch { /* row unchanged if upsert fails */ }

    res.json({
      success: true,
      flagCount: currentFlags.length,
      autoQuarantined: currentFlags.length >= AUTO_QUARANTINE_THRESHOLD,
    });
  } catch (err) { next(err); }
});

// Read own flags — user can undo their flag
router.delete("/user/flag-comp/:rowId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const rowId = String(req.params.rowId ?? "").trim();
    const cardId = String((req.query.cardId as string | undefined) ?? "").trim();
    if (!rowId || !cardId) { res.status(400).json({ success: false, error: "rowId + cardId required" }); return; }

    const sc = await getSoldComps();
    if (!sc) { res.status(503).json({ success: false, error: "Cosmos not configured" }); return; }
    let row: Record<string, unknown> | null = null;
    try { const { resource } = await sc.item(rowId, cardId).read(); row = (resource as Record<string, unknown>) ?? null; } catch { row = null; }
    if (!row) { res.status(404).json({ success: false, error: "row not found" }); return; }

    const flags = Array.isArray((row as { __userFlags?: string[] }).__userFlags)
      ? ((row as { __userFlags?: string[] }).__userFlags as string[]).filter((u) => u !== auth.userId)
      : [];
    const next: Record<string, unknown> = { ...row, __userFlags: flags };
    if (flags.length < AUTO_QUARANTINE_THRESHOLD) {
      delete next.__userFlagQuarantine;
      delete next.__userFlagQuarantineAt;
    }
    await sc.items.upsert(next);
    res.json({ success: true, flagCount: flags.length });
  } catch (err) { next(err); }
});

export default router;

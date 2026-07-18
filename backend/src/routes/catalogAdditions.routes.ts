// CF-CH-ADDITIONS-INGEST (Drew, 2026-07-17). Routes for the CH
// catalog-additions surface:
//
//   GET  /api/catalog/additions?since=YYYY-MM-DD[&category=...]
//     Read the persisted additions in a window. Consumer feed for
//     iOS "new drops" surface.
//
//   POST /api/catalog/additions/ingest
//     Trigger the ingest orchestrator. Used by the scheduled workflow
//     and by admin one-off runs. Optional body: { startDate, endDate,
//     category }. Session-required (Drew's admin role).

import { Router, type Request, type Response } from "express";
import { getUserBySession } from "../services/authService.js";
import { requireSession } from "../middleware/requireSession.js";

const router = Router();

async function requireUserId(req: Request, res: Response): Promise<string | null> {
  if (req.user?.userId) return req.user.userId;
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) {
    res.status(401).json({ error: "Missing x-session-id" });
    return null;
  }
  const user = await getUserBySession(sessionId);
  if (!user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }
  return user.userId;
}

router.get("/additions", requireSession, async (req: Request, res: Response, next) => {
  try {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    const since = String(req.query.since ?? "").trim() || defaultSince();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return res.status(400).json({ error: "since must be YYYY-MM-DD" });
    }
    const category = typeof req.query.category === "string" && req.query.category.trim().length > 0
      ? req.query.category.trim()
      : undefined;
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));

    const { readAdditionsSince } = await import("../services/catalog/chAdditionsStore.service.js");
    const rows = await readAdditionsSince(since, { category, limit });
    res.json({
      computedAt: new Date().toISOString(),
      since,
      category: category ?? null,
      count: rows.length,
      additions: rows,
    });
  } catch (err) { next(err); }
});

router.post("/additions/ingest", requireSession, async (req: Request, res: Response, next) => {
  try {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    // For MVP, any authenticated user can trigger — we'll gate to
    // admin role in a follow-up. Ingest is idempotent so the blast
    // radius is a bit of eBay quota cost, nothing destructive.
    const startDate = typeof req.body?.startDate === "string" ? req.body.startDate : undefined;
    const endDate = typeof req.body?.endDate === "string" ? req.body.endDate : undefined;
    const category = typeof req.body?.category === "string" ? req.body.category : undefined;

    const { ingestCatalogAdditions } = await import("../services/catalog/chAdditionsIngest.service.js");
    const summary = await ingestCatalogAdditions({ startDate, endDate, category });
    res.json({ success: true, summary });
  } catch (err) { next(err); }
});

function defaultSince(): string {
  const d = new Date(Date.now() - 14 * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export default router;

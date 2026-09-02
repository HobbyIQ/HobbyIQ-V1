// CF-BUYERIQ (Drew, 2026-07-31). REST surface for the BuyerIQ iOS
// feature. Session-gated (requireSession) but not entitlement-gated —
// the feature is available to every plan (buying lists are useful
// regardless of tier; monetization comes from cross-sells elsewhere).
//
// Endpoints:
//   GET    /api/buyeriq/lists                 — user's lists (most recent first)
//   POST   /api/buyeriq/lists                 — create list (body: { name, description?, showDate?, showLocation? })
//   PUT    /api/buyeriq/lists/:listId         — update list (body: same fields)
//   DELETE /api/buyeriq/lists/:listId         — delete list (cascades targets)
//   GET    /api/buyeriq/targets?listId=<id>   — targets, optionally filtered by list
//   POST   /api/buyeriq/targets               — create target
//   PUT    /api/buyeriq/targets/:targetId     — update target
//   DELETE /api/buyeriq/targets/:targetId     — delete target
//   GET    /api/buyeriq/deals                 — deal scan over the user's targets

import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import { requireRateLimited } from "../middleware/requireRateLimited.js";
import { randomUUID } from "node:crypto";
import {
  listLists,
  upsertList,
  deleteList,
  listTargets,
  upsertTarget,
  deleteTarget,
  type BuyerIqList,
  type BuyerIqTarget,
} from "../services/buyeriq/buyeriqStore.service.js";
import { scanDeals } from "../services/buyeriq/dealFeed.service.js";
import { DEFAULT_BASE_DISCOUNT_PCT, MAX_REQUIRED_DISCOUNT_PCT } from "../services/buyeriq/dealGate.js";

const router = Router();
router.use(requireSession);

function nonEmpty(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : null;
}

// ─── Lists ────────────────────────────────────────────────────────────

router.get("/lists", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const lists = await listLists(userId);
  res.json({ success: true, lists });
});

router.post("/lists", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const body = req.body ?? {};
  const name = nonEmpty(body.name);
  if (!name) return res.status(400).json({ success: false, error: "name required" });
  const now = new Date().toISOString();
  const doc: BuyerIqList = {
    id: randomUUID(),
    userId,
    docType: "list",
    name,
    description: nonEmpty(body.description),
    showDate: nonEmpty(body.showDate),
    showLocation: nonEmpty(body.showLocation),
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  const written = await upsertList(doc);
  if (!written) return res.status(500).json({ success: false, error: "write failed" });
  res.json({ success: true, list: written });
});

router.put("/lists/:listId", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const listId = String(req.params.listId);
  const body = req.body ?? {};
  const existing = (await listLists(userId)).find((l) => l.id === listId);
  if (!existing) return res.status(404).json({ success: false, error: "list not found" });
  const doc: BuyerIqList = {
    ...existing,
    name: nonEmpty(body.name) ?? existing.name,
    description: body.description === undefined ? existing.description : nonEmpty(body.description),
    showDate: body.showDate === undefined ? existing.showDate : nonEmpty(body.showDate),
    showLocation: body.showLocation === undefined ? existing.showLocation : nonEmpty(body.showLocation),
    archived: typeof body.archived === "boolean" ? body.archived : existing.archived,
  };
  const written = await upsertList(doc);
  if (!written) return res.status(500).json({ success: false, error: "write failed" });
  res.json({ success: true, list: written });
});

router.delete("/lists/:listId", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const ok = await deleteList(userId, String(req.params.listId));
  if (!ok) return res.status(404).json({ success: false, error: "list not found" });
  res.json({ success: true });
});

// ─── Targets ──────────────────────────────────────────────────────────

router.get("/targets", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const listId = typeof req.query.listId === "string" ? req.query.listId : undefined;
  const targets = await listTargets(userId, listId);
  res.json({ success: true, targets });
});

router.post("/targets", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const body = req.body ?? {};
  const listId = nonEmpty(body.listId);
  const playerName = nonEmpty(body.playerName);
  if (!listId || !playerName) {
    return res.status(400).json({ success: false, error: "listId and playerName required" });
  }
  const now = new Date().toISOString();
  const priorityRaw = String(body.priority ?? "medium").toLowerCase();
  const priority: "high" | "medium" | "low" =
    priorityRaw === "high" || priorityRaw === "low" ? priorityRaw : "medium";
  const statusRaw = String(body.status ?? "wanted").toLowerCase();
  const status: "wanted" | "acquired" | "passed" =
    statusRaw === "acquired" || statusRaw === "passed" ? statusRaw : "wanted";
  const doc: BuyerIqTarget = {
    id: randomUUID(),
    userId,
    docType: "target",
    listId,
    hobbyiqCardId: nonEmpty(body.hobbyiqCardId),
    playerName,
    cardYear: typeof body.cardYear === "number" ? body.cardYear : null,
    cardNumber: nonEmpty(body.cardNumber),
    setName: nonEmpty(body.setName),
    parallel: nonEmpty(body.parallel),
    isAuto: typeof body.isAuto === "boolean" ? body.isAuto : null,
    gradeCompany: nonEmpty(body.gradeCompany),
    gradeValue: typeof body.gradeValue === "number" ? body.gradeValue : null,
    imageUrl: nonEmpty(body.imageUrl),
    maxPrice: typeof body.maxPrice === "number" ? body.maxPrice : null,
    priority,
    notes: nonEmpty(body.notes),
    status,
    acquiredAt: nonEmpty(body.acquiredAt),
    acquiredPrice: typeof body.acquiredPrice === "number" ? body.acquiredPrice : null,
    createdAt: now,
    updatedAt: now,
  };
  const written = await upsertTarget(doc);
  if (!written) return res.status(500).json({ success: false, error: "write failed" });
  res.json({ success: true, target: written });
});

router.put("/targets/:targetId", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const body = req.body ?? {};
  const existing = (await listTargets(userId)).find((t) => t.id === String(req.params.targetId));
  if (!existing) return res.status(404).json({ success: false, error: "target not found" });
  // Auto-stamp acquiredAt when status flips to acquired and caller
  // didn't set it explicitly — the whole point of "acquired" as a
  // status is the timestamp for post-show analytics.
  let acquiredAt = body.acquiredAt === undefined ? existing.acquiredAt : nonEmpty(body.acquiredAt);
  const nextStatus = typeof body.status === "string" ? body.status : existing.status;
  if (nextStatus === "acquired" && !acquiredAt) {
    acquiredAt = new Date().toISOString();
  }
  const doc: BuyerIqTarget = {
    ...existing,
    hobbyiqCardId: body.hobbyiqCardId === undefined ? existing.hobbyiqCardId : nonEmpty(body.hobbyiqCardId),
    playerName: nonEmpty(body.playerName) ?? existing.playerName,
    cardYear: body.cardYear === undefined ? existing.cardYear : (typeof body.cardYear === "number" ? body.cardYear : null),
    cardNumber: body.cardNumber === undefined ? existing.cardNumber : nonEmpty(body.cardNumber),
    setName: body.setName === undefined ? existing.setName : nonEmpty(body.setName),
    parallel: body.parallel === undefined ? existing.parallel : nonEmpty(body.parallel),
    isAuto: body.isAuto === undefined ? existing.isAuto : (typeof body.isAuto === "boolean" ? body.isAuto : null),
    gradeCompany: body.gradeCompany === undefined ? existing.gradeCompany : nonEmpty(body.gradeCompany),
    gradeValue: body.gradeValue === undefined ? existing.gradeValue : (typeof body.gradeValue === "number" ? body.gradeValue : null),
    imageUrl: body.imageUrl === undefined ? existing.imageUrl : nonEmpty(body.imageUrl),
    maxPrice: body.maxPrice === undefined ? existing.maxPrice : (typeof body.maxPrice === "number" ? body.maxPrice : null),
    priority: typeof body.priority === "string"
      ? (body.priority === "high" || body.priority === "low" ? body.priority : "medium")
      : existing.priority,
    notes: body.notes === undefined ? existing.notes : nonEmpty(body.notes),
    status: nextStatus === "acquired" || nextStatus === "passed" || nextStatus === "wanted"
      ? nextStatus as "wanted" | "acquired" | "passed"
      : existing.status,
    acquiredAt,
    acquiredPrice: body.acquiredPrice === undefined ? existing.acquiredPrice : (typeof body.acquiredPrice === "number" ? body.acquiredPrice : null),
  };
  const written = await upsertTarget(doc);
  if (!written) return res.status(500).json({ success: false, error: "write failed" });
  res.json({ success: true, target: written });
});

router.delete("/targets/:targetId", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const ok = await deleteTarget(userId, String(req.params.targetId));
  if (!ok) return res.status(404).json({ success: false, error: "target not found" });
  res.json({ success: true });
});

// ─── Deal scanner ─────────────────────────────────────────────────────
// CF-BUYERIQ-DEAL-FEED (Drew, 2026-09-02). Compares live asks on the
// user's wanted targets against each card's canonical projected next
// sale and returns the ones listed far enough under to matter.
//
// GET /api/buyeriq/deals?listId=<id>&threshold=0.20
//
//   listId     optional — restrict to one buying list
//   threshold  optional — base discount at FULL confidence, as a
//              fraction (0.20 = 20% under) or a percent (20 = 20%).
//              Default 0.20. The REQUIRED discount slides up from here
//              as the projection's confidence falls.
//
// Read-only: no valuation is computed differently, nothing is written.
// Rate-limited on priceChecksPerDay — one scan prices many cards, the
// same budget listing-range draws on.
//
// A scan that ran out of vendor-call budget returns 200 with
// complete:false and stoppedReason set. Callers MUST NOT render a
// truncated feed as though it were the whole market.
function parseThreshold(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Accept both 0.20 and 20 — the query string is user-facing.
  const asFraction = n > 1 ? n / 100 : n;
  return Math.max(0.02, Math.min(MAX_REQUIRED_DISCOUNT_PCT, asFraction));
}

router.get("/deals", requireRateLimited("priceChecksPerDay"), async (req: Request, res: Response, next) => {
  try {
    const userId = req.user!.userId;
    const listId = typeof req.query.listId === "string" && req.query.listId.trim().length > 0
      ? req.query.listId.trim()
      : undefined;
    const threshold = parseThreshold(req.query.threshold) ?? DEFAULT_BASE_DISCOUNT_PCT;

    const result = await scanDeals({ userId, listId, baseDiscountPct: threshold });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

export default router;

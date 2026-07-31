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

import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
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

export default router;

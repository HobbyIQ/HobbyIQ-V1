// CF-VERIFY-QUEUE-ROUTES (Drew, 2026-07-28).
//
// Admin surface for the human-in-the-loop verify queue + pool quality
// report. Gated by requireAdmin (bearer token via ADMIN_API_TOKEN).
//
// Endpoints:
//   GET  /api/verify/queue                   list pending items (filter by ?reason=)
//   GET  /api/verify/queue/count             count of pending items (fast, no docs)
//   POST /api/verify/queue/:reason/:id       resolve a queued item
//                                            body: { action, correction?, adminUserId }
//   GET  /api/data-quality/report            pool-level quality metrics
//                                            (?cutoffDays=180)

import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  listPending,
  countPending,
  resolveQueued,
  type ResolveQueuedOptions,
  type VerifyReason,
} from "../services/portfolioiq/verifyQueue.service.js";
import { computeDataQualityReport } from "../services/portfolioiq/dataQuality.service.js";

const router = Router();
router.use(requireAdmin);

const VALID_REASONS: readonly VerifyReason[] = [
  "price-outlier",
  "parser-low-confidence",
  "slug-conflict",
  "cross-source-mismatch",
  "sample-audit",
  "manual",
  "divergence-alert",
];

router.get("/verify/queue", async (req, res, next) => {
  try {
    const reason = typeof req.query.reason === "string"
      ? (VALID_REASONS.includes(req.query.reason as VerifyReason) ? (req.query.reason as VerifyReason) : undefined)
      : undefined;
    const limitRaw = req.query.limit;
    const limit = typeof limitRaw === "string" ? Number(limitRaw) : undefined;
    const continuation = typeof req.query.continuation === "string" ? req.query.continuation : undefined;
    const out = await listPending({ reason, limit, continuation });
    res.json({ success: true, ...out });
  } catch (err) {
    next(err);
  }
});

router.get("/verify/queue/count", async (req, res, next) => {
  try {
    const reason = typeof req.query.reason === "string"
      ? (VALID_REASONS.includes(req.query.reason as VerifyReason) ? (req.query.reason as VerifyReason) : undefined)
      : undefined;
    const count = await countPending(reason);
    res.json({ success: true, count, reason: reason ?? "all" });
  } catch (err) {
    next(err);
  }
});

router.post("/verify/queue/:reason/:id", async (req, res, next) => {
  try {
    const { reason, id } = req.params;
    if (!VALID_REASONS.includes(reason as VerifyReason)) {
      return res.status(400).json({ success: false, error: `invalid reason: ${reason}` });
    }
    const body = (req.body ?? {}) as {
      action?: unknown;
      correction?: Record<string, unknown>;
      adminUserId?: unknown;
    };
    const action = body.action;
    if (action !== "approve" && action !== "reject" && action !== "fix") {
      return res.status(400).json({ success: false, error: `action must be one of: approve, reject, fix` });
    }
    const adminUserId = typeof body.adminUserId === "string" && body.adminUserId.trim() ? body.adminUserId.trim() : "admin";
    const result = await resolveQueued(id, reason as VerifyReason, action, {
      adminUserId,
      correction: (body.correction as ResolveQueuedOptions["correction"]) ?? undefined,
    });
    if (!result.ok) {
      return res.status(result.reason === "not-found" ? 404 : 400).json({ success: false, ...result });
    }
    res.json({ success: true, id, reason, action });
  } catch (err) {
    next(err);
  }
});

router.get("/data-quality/report", async (req, res, next) => {
  try {
    const cutoffRaw = req.query.cutoffDays;
    const cutoffDays = typeof cutoffRaw === "string" && Number.isFinite(Number(cutoffRaw))
      ? Math.max(1, Math.min(365, Number(cutoffRaw)))
      : 180;
    const report = await computeDataQualityReport(cutoffDays);
    res.json({ success: true, report });
  } catch (err) {
    next(err);
  }
});

export default router;

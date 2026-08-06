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
  "catalog-gap",
  "parallel-price-mismatch",
  "image-mismatch",
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

// CF-PARALLEL-TRAIN (Drew, 2026-08-06). Human-in-the-loop labeling for
// the OCR + price-nearest-sibling disambiguator. GET returns one
// anomaly row with its image, OCR text, and neighboring parallels;
// POST records the human's chosen parallel and patches the staging row.
// Each label is logged to verify_corrections so we can train against
// the accumulated corpus.
import { CosmosClient } from "@azure/cosmos";
import { ocrImageUrl } from "../services/portfolioiq/azureVisionOcr.service.js";
import { parseHobbyIqCardId, computeHobbyIqCardId } from "../services/portfolioiq/hobbyIqCardId.service.js";

function upgradeImageUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  return u
    .replace(/\/s-l\d+\.webp$/i, "/s-l1600.jpg")
    .replace(/\/s-l\d+\.jpg$/i, "/s-l1600.jpg");
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s.length % 2 === 0 ? (s[s.length/2 - 1] + s[s.length/2]) / 2 : s[Math.floor(s.length/2)]);
}

router.get("/verify/parallel-train/next", async (req, res, next) => {
  try {
    const color = typeof req.query.color === "string" ? req.query.color.toLowerCase() : "blue";
    const mode = typeof req.query.mode === "string" ? req.query.mode.toLowerCase() : "non-auto";
    const conn = process.env.COSMOS_CONNECTION_STRING;
    if (!conn) return res.status(503).json({ success: false, error: "cosmos not configured" });
    const c = new CosmosClient(conn);
    const stage = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("comps_staging");
    const sold = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");

    const autoFilter = mode === "auto"
      ? `AND (ENDSWITH(c.hobbyiqCardId, ":auto") OR CONTAINS(c.hobbyiqCardId, ":auto:num-"))`
      : `AND (ENDSWITH(c.hobbyiqCardId, ":no-auto") OR CONTAINS(c.hobbyiqCardId, ":no-auto:num-"))`;
    // Random-ish sampling: pull 20, pick one that hasn't been labeled today.
    // Narrow to rows most likely to have parallel misclassification:
    // status=anomaly AND at least one anomaly kind is parser-low-confidence
    // (title vs slug disagreement on parallel/setKey/isAuto). Skip rows
    // where the anomaly is only about price/image — those don't need
    // this tool.
    const { resources: rows } = await stage.items.query({
      query: `SELECT TOP 20 c.id, c.hobbyiqCardId, c.raw, c.reclassifiedAt FROM c
              WHERE c.status = "anomaly"
                AND CONTAINS(LOWER(c.raw.vendorPayload.title), @c)
                AND IS_DEFINED(c.raw.vendorPayload.imageUrl)
                AND c.raw.vendorPayload.imageUrl != null
                AND EXISTS(SELECT VALUE a FROM a IN c.clean.anomalies WHERE a.kind = "parser-low-confidence")
                ${autoFilter}`,
      parameters: [{ name: "@c", value: color }],
    }).fetchAll();
    if (rows.length === 0) return res.json({ success: true, item: null });

    const item = rows[Math.floor(Math.random() * rows.length)] as {
      id: string;
      hobbyiqCardId: string;
      raw: { vendorPayload: { title?: string; imageUrl?: string; price?: number }; identityHint?: { parallel?: string; playerName?: string } };
    };
    const title = item.raw?.vendorPayload?.title ?? "";
    const rawUrl = item.raw?.vendorPayload?.imageUrl ?? null;
    const price = Number(item.raw?.vendorPayload?.price ?? 0);
    const bigImage = upgradeImageUrl(rawUrl);

    // Siblings
    const parts = item.hobbyiqCardId.split(":");
    const stem = parts.slice(0, 5).join(":") + ":";
    const { resources: sibRows } = await sold.items.query<{ p: string; price: number; url: string; source: string }>({
      query: `SELECT c.parallel as p, c.price, c.url, c.source FROM c
              WHERE STARTSWITH(c.hobbyiqCardId, @s) AND CONTAINS(LOWER(c.parallel), @c) AND c.price > 0
                AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)`,
      parameters: [{ name: "@s", value: stem }, { name: "@c", value: color }],
    }, { maxItemCount: 1000 }).fetchAll();
    const byParallel = new Map<string, { prices: number[]; sampleUrl: string | null }>();
    for (const r of sibRows) {
      const p = String(r.p ?? "").toLowerCase().trim();
      if (!p) continue;
      const arr = byParallel.get(p) ?? { prices: [], sampleUrl: null };
      arr.prices.push(Number(r.price));
      if (!arr.sampleUrl && r.url) arr.sampleUrl = upgradeImageUrl(r.url);
      byParallel.set(p, arr);
    }
    const siblings = [...byParallel.entries()]
      .map(([par, v]) => ({ parallel: par, medianPrice: Math.round(median(v.prices) * 100) / 100, n: v.prices.length, sampleImageUrl: v.sampleUrl }))
      .sort((a, b) => Math.abs(a.medianPrice - price) - Math.abs(b.medianPrice - price))
      .slice(0, 10);

    // OCR — best-effort, don't fail the endpoint if it errors
    let ocrText = "";
    if (bigImage) {
      try {
        const ocr = await ocrImageUrl(bigImage);
        if (ocr.ok) ocrText = ocr.rawText ?? "";
      } catch { /* skip */ }
    }

    res.json({
      success: true,
      item: {
        stagingId: item.id,
        hobbyiqCardId: item.hobbyiqCardId,
        title,
        price,
        storedParallel: item.raw?.identityHint?.parallel ?? "",
        imageUrl: bigImage,
        ocrText,
        siblings,
      },
    });
  } catch (err) { next(err); }
});

router.post("/verify/parallel-train/:stagingId/label", async (req, res, next) => {
  try {
    const { stagingId } = req.params;
    const body = (req.body ?? {}) as {
      chosenParallel?: string;
      chosenCardNumber?: string;
      note?: string;
      adminUserId?: string;
      action?: "assign" | "skip" | "unknown";
    };
    const action = body.action ?? "assign";
    const chosenParallel = typeof body.chosenParallel === "string" ? body.chosenParallel.trim() : "";
    const adminUserId = typeof body.adminUserId === "string" && body.adminUserId.trim() ? body.adminUserId.trim() : "admin";
    if (action === "assign" && !chosenParallel) {
      return res.status(400).json({ success: false, error: "chosenParallel required when action=assign" });
    }
    const conn = process.env.COSMOS_CONNECTION_STRING;
    if (!conn) return res.status(503).json({ success: false, error: "cosmos not configured" });
    const c = new CosmosClient(conn);
    const stage = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("comps_staging");
    const corrections = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("verify_corrections");

    // Load the row (find by id, cross-partition — id is not the partition key)
    const { resources } = await stage.items.query<{ id: string; hobbyiqCardId: string; raw: { identityHint?: { parallel?: string } } }>({
      query: "SELECT c.id, c.hobbyiqCardId, c.raw FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: stagingId }],
    }).fetchAll();
    if (resources.length === 0) return res.status(404).json({ success: false, error: "row not found" });
    const row = resources[0];
    const now = new Date().toISOString();

    let newSlug: string | null = null;
    if (action === "assign") {
      const parsed = parseHobbyIqCardId(row.hobbyiqCardId);
      if (!parsed) return res.status(400).json({ success: false, error: `cannot parse existing slug: ${row.hobbyiqCardId}` });
      newSlug = computeHobbyIqCardId({ ...parsed, parallel: chosenParallel });
      if (!newSlug || newSlug.includes("::")) {
        return res.status(400).json({ success: false, error: `computed slug is malformed: ${newSlug}` });
      }
    }

    // Log the correction (training example) regardless of action
    await corrections.items.upsert({
      id: `parallel-train::${stagingId}::${Date.now()}`,
      partitionKey: adminUserId,
      kind: "parallel-train",
      stagingId,
      originalSlug: row.hobbyiqCardId,
      newSlug: newSlug,
      chosenParallel: chosenParallel || null,
      chosenCardNumber: body.chosenCardNumber ?? null,
      action,
      note: body.note ?? null,
      adminUserId,
      labeledAt: now,
    });

    if (action === "assign" && newSlug && newSlug !== row.hobbyiqCardId) {
      // Patch the staging row: new parallel, new slug, reset status → pending
      await stage.item(row.id, row.hobbyiqCardId).patch({
        operations: [
          { op: "set", path: "/raw/identityHint/parallel", value: chosenParallel },
          { op: "set", path: "/hobbyiqCardId", value: newSlug },
          { op: "set", path: "/status", value: "pending" },
          { op: "set", path: "/reclassifiedAt", value: now },
          { op: "set", path: "/reclassifyReason", value: `human-label:${adminUserId}` },
        ],
      } as never);
    }
    res.json({ success: true, action, newSlug: newSlug ?? row.hobbyiqCardId });
  } catch (err) { next(err); }
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

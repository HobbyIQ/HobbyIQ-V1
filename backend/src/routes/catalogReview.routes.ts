// CF-CATALOG-REVIEW-ROUTES (Drew, 2026-08-08). Admin surface for the
// two review buckets:
//   - user-seeded catalog entries (verificationStatus='pending-review')
//   - vendor-unmatched staging rows (status='catalog-unmatched')
//
// Approve → verify catalog entry (or create + re-promote staged sales).
// Reject → delete entry / reject staged sales.

import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  approveUserSeeded,
  approveVendorUnmatched,
  listReviewQueue,
  rejectUserSeeded,
  rejectVendorUnmatched,
} from "../services/portfolioiq/catalogReview.service.js";
import { diffChecklistAgainstCatalog } from "../services/portfolioiq/checklistDiff.service.js";

const router = Router();
router.use(requireAdmin);

router.get("/catalog-review/queue", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? Math.max(1, Math.min(200, Number(req.query.limit))) : 50;
    const type = (req.query.type as "user-seeded" | "vendor-unmatched" | "all") ?? "all";
    const result = await listReviewQueue({ limit, type });
    if (!result) { res.status(503).json({ success: false, error: "Cosmos not configured" }); return; }
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.post("/catalog-review/approve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = String(req.body?.slug ?? "").trim();
    const type = req.body?.type as "user-seeded" | "vendor-unmatched";
    if (!slug || !slug.startsWith("hiq:")) { res.status(400).json({ success: false, error: "invalid-slug" }); return; }
    if (type !== "user-seeded" && type !== "vendor-unmatched") { res.status(400).json({ success: false, error: "invalid-type" }); return; }
    const note = typeof req.body?.note === "string" ? req.body.note : undefined;
    const result = type === "user-seeded"
      ? await approveUserSeeded(slug, note)
      : await approveVendorUnmatched(slug);
    if (!result.ok) { res.status(500).json({ success: false, ...result }); return; }
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.post("/catalog-review/reject", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = String(req.body?.slug ?? "").trim();
    const type = req.body?.type as "user-seeded" | "vendor-unmatched";
    if (!slug || !slug.startsWith("hiq:")) { res.status(400).json({ success: false, error: "invalid-slug" }); return; }
    if (type !== "user-seeded" && type !== "vendor-unmatched") { res.status(400).json({ success: false, error: "invalid-type" }); return; }
    const result = type === "user-seeded"
      ? await rejectUserSeeded(slug)
      : await rejectVendorUnmatched(slug);
    if (!result.ok) { res.status(500).json({ success: false, ...result }); return; }
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// CF-CATALOG-REVIEW-BULK (Drew, 2026-08-08). Batch approve/reject so admin
// can triage a page of items in one action. Body: { items: [{ slug, type },
// ...], action: 'approve' | 'reject' }. Runs sequentially per-item so a
// single slug failure doesn't corrupt the whole batch; returns a per-item
// result array + overall counts.
router.post("/catalog-review/bulk", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const action = String(req.body?.action ?? "").trim();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (action !== "approve" && action !== "reject") {
      res.status(400).json({ success: false, error: "invalid-action" });
      return;
    }
    if (!items.length || items.length > 200) {
      res.status(400).json({ success: false, error: "items-length" });
      return;
    }
    let succeeded = 0;
    let failed = 0;
    const results: Array<{ slug: string; ok: boolean; staged?: number; error?: string }> = [];
    for (const it of items as Array<{ slug: unknown; type: unknown }>) {
      const slug = String(it.slug ?? "").trim();
      const type = it.type as "user-seeded" | "vendor-unmatched";
      if (!slug || !slug.startsWith("hiq:") || (type !== "user-seeded" && type !== "vendor-unmatched")) {
        results.push({ slug, ok: false, error: "invalid-item" });
        failed++;
        continue;
      }
      let result;
      if (action === "approve") {
        result = type === "user-seeded" ? await approveUserSeeded(slug) : await approveVendorUnmatched(slug);
      } else {
        result = type === "user-seeded" ? await rejectUserSeeded(slug) : await rejectVendorUnmatched(slug);
      }
      results.push({ slug, ...result });
      if (result.ok) succeeded++; else failed++;
    }
    res.json({ success: true, action, succeeded, failed, total: items.length, results });
  } catch (err) { next(err); }
});

// CF-CHECKLIST-DIFF-ROUTE (Drew, 2026-08-08). Paste a product checklist,
// diff against catalog for the given year+set. Powers the "confirm
// against product checklist" step of admin review.
router.post("/catalog-review/checklist-diff", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const checklistText = String(req.body?.checklistText ?? "").slice(0, 100_000);
    const year = Number(req.body?.year);
    const setName = String(req.body?.setName ?? "").trim();
    const sport = typeof req.body?.sport === "string" ? req.body.sport : undefined;
    if (!checklistText.trim()) { res.status(400).json({ success: false, error: "checklistText required" }); return; }
    if (!Number.isFinite(year) || year < 1900 || year > 2100) { res.status(400).json({ success: false, error: "invalid year" }); return; }
    if (!setName) { res.status(400).json({ success: false, error: "setName required" }); return; }
    const result = await diffChecklistAgainstCatalog({ checklistText, year, setName, sport });
    if (!result) { res.status(503).json({ success: false, error: "Cosmos not configured" }); return; }
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

export default router;

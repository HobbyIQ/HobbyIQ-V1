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

export default router;

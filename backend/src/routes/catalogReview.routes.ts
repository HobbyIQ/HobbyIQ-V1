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
import { createCatalogEntriesFromChecklist, diffChecklistAgainstCatalog } from "../services/portfolioiq/checklistDiff.service.js";

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

// CF-CHECKLIST-FETCH-BASEBALL-ALMANAC (Drew, 2026-08-08). Admin pastes
// a Baseball Almanac set-checklist URL; backend fetches + extracts the
// card list in "cardNumber playerName" format ready to drop into the
// checklist textarea. Respects the source: only fires on explicit admin
// click, one URL at a time. No mass-scraping.
router.post("/catalog-review/fetch-checklist-url", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const url = String(req.body?.url ?? "").trim();
    if (!url || !/^https?:\/\//i.test(url)) { res.status(400).json({ success: false, error: "invalid url" }); return; }
    const parsed = new URL(url);
    if (!/(^|\.)baseball-almanac\.com$/i.test(parsed.hostname)) {
      res.status(400).json({ success: false, error: "only baseball-almanac.com URLs supported at this time" });
      return;
    }
    const r = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "HobbyIQ/1.0 (admin checklist import)" },
    });
    if (!r.ok) { res.status(502).json({ success: false, error: `upstream ${r.status}` }); return; }
    const html = await r.text();
    // Strip HTML → plain text, then find "<num> <name>" lines. Baseball
    // Almanac's card list has cardNumber in the leftmost column of a
    // table, player name in the next. After tag strip they appear as
    // "<num>\t<player>" or "<num> <player>".
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<\/?(td|th|tr|br|p|div)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#\d+;/g, "")
      .replace(/\t+/g, " ");
    const lines = stripped.split(/\r?\n/);
    // Match card number in first token: 1-4 digits OR letters+digits (e.g. BDP129).
    const lineRx = /^(\d{1,4}[a-z]?|[A-Za-z]{1,6}-?[A-Za-z0-9]+)\s+([A-Z][A-Za-z.'\- ]{2,60}?)\s*$/;
    const checklist: Array<{ cardNumber: string; player: string }> = [];
    const seen = new Set<string>();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.length > 100) continue;
      const m = line.match(lineRx);
      if (!m) continue;
      const cn = m[1].toUpperCase();
      const player = m[2].trim();
      // Skip obviously-not-a-player entries (all caps, single-word words > 3 chars, etc.)
      if (/^(RC|SP|HOF|MVP|CY|POY|ROY|BASE|CARD|SET|PLAYER|TEAM|POS|BATS|THROWS|BORN|DIED|CHECKLIST)$/i.test(player)) continue;
      if (!/^[A-Z][a-z]/.test(player)) continue; // Must start with proper-noun casing
      const key = `${cn}|${player.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      checklist.push({ cardNumber: cn, player });
    }
    // Reconstruct as a textarea-friendly string (one row per line, no header)
    const text = checklist.map((c) => `${c.cardNumber} ${c.player}`).join("\n");
    res.json({ success: true, url, count: checklist.length, text, checklist });
  } catch (err) { next(err); }
});

// CF-CHECKLIST-ADD-MISSING (Drew, 2026-08-08). Bulk-create catalog
// entries for cards on a pasted checklist that AREN'T yet in catalog.
// Each entry lands as verificationStatus='pending-review' so the admin
// still explicitly approves before it counts as canonical.
router.post("/catalog-review/checklist-add-missing", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const year = Number(req.body?.year);
    const setName = String(req.body?.setName ?? "").trim();
    const sport = String(req.body?.sport ?? "baseball").trim().toLowerCase();
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!Number.isFinite(year) || year < 1900 || year > 2100) { res.status(400).json({ success: false, error: "invalid year" }); return; }
    if (!setName) { res.status(400).json({ success: false, error: "setName required" }); return; }
    if (!rows.length || rows.length > 2000) { res.status(400).json({ success: false, error: "rows length 1..2000" }); return; }
    const result = await createCatalogEntriesFromChecklist({ year, sport, setName, rows });
    if (!result) { res.status(503).json({ success: false, error: "Cosmos not configured" }); return; }
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

export default router;

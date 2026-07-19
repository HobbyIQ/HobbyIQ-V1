// CF-RECENT-SALES-FEED (Drew, 2026-07-18). "Show me the actual comps
// backing this FMV" — a lightweight read-through of sold_comps for a
// specific (cardId, parallel, grade). Card Detail page renders this as
// a scrollable list under the FMV headline: real user + CH sales that
// justify the projected next-sale number.
//
// Route: GET /api/compiq/cards/:cardId/recent-sales
// Auth:  requireSession
//
// Query params:
//   parallel        — "Blue Refractor" etc. (empty string → base only)
//   gradeCompany    — "PSA" | "BGS" | "SGC" | absent for raw
//   gradeValue      — numeric grade; absent for raw
//   days            — lookback window (default 180, max 365)
//   limit           — max rows returned (default 25, max 100)
//
// Response:
//   {
//     count: number,           // total comps AFTER filter (not clipped by limit)
//     sales: [
//       { source, price, soldAt, title, parallel, gradeCompany, gradeValue,
//         cardYear, cardNumber, contributorUserId (only for own comps),
//         imageUrl, sellerHandle }
//     ]
//   }
//
// Privacy: contributorUserId is redacted unless the row's contributor
// matches the requesting session — users see anonymized comps but their
// own entries stay attributed. sellerHandle is passed through from the
// source (already public on eBay listings).

import { Router, type Request, type Response } from "express";
import { getUserBySession } from "../services/authService.js";
import { requireSession } from "../middleware/requireSession.js";
import { readCompsByCardId } from "../services/portfolioiq/soldCompsStore.service.js";

const router = Router();

async function resolveRequestingUserId(req: Request): Promise<string | null> {
  if (req.user?.userId) return req.user.userId;
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) return null;
  const user = await getUserBySession(sessionId);
  return user?.userId ?? null;
}

router.get("/cards/:cardId/recent-sales", requireSession, async (req: Request, res: Response, next) => {
  try {
    const cardId = String(req.params.cardId ?? "").trim();
    if (!cardId) {
      res.status(400).json({ error: "cardId required" });
      return;
    }

    const requesterId = await resolveRequestingUserId(req);

    // Only apply the parallel filter when the caller EXPLICITLY sent
    // the parallel query param — an absent param means "no filter, show
    // all parallels for this cardId." An empty string ("") means "base
    // only," which readCompsByCardId already handles via BASE_ALIASES.
    const parallel: string | null | undefined = typeof req.query.parallel === "string"
      ? req.query.parallel
      : undefined;

    const gradeCompany: string | undefined = typeof req.query.gradeCompany === "string" && req.query.gradeCompany.trim().length > 0
      ? req.query.gradeCompany.trim()
      : undefined;
    const gradeValue: number | undefined = typeof req.query.gradeValue === "string" && req.query.gradeValue.trim().length > 0
      ? Number(req.query.gradeValue)
      : undefined;

    const daysRaw = typeof req.query.days === "string" ? Number(req.query.days) : NaN;
    const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365 ? daysRaw : 180;

    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? Math.floor(limitRaw) : 25;

    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const comps = await readCompsByCardId({
      cardId,
      fromDate,
      // sources: undefined → all sources (user + CH + CS + browse-ended)
      parallel: parallel !== undefined ? parallel : undefined,
      gradeCompany: gradeCompany,
      gradeValue: gradeValue,
    });

    const sales = comps
      .slice(0, limit)
      .map((c) => ({
        source: c.source,
        price: c.price,
        soldAt: c.soldAt,
        title: c.title ?? null,
        parallel: c.parallel ?? null,
        gradeCompany: c.gradeCompany ?? null,
        gradeValue: c.gradeValue ?? null,
        cardYear: c.cardYear ?? null,
        cardNumber: c.cardNumber ?? null,
        imageUrl: c.imageUrl ?? null,
        sellerHandle: c.sellerHandle ?? null,
        // Attribute only the caller's own contributions; anonymize
        // everyone else's so we don't leak identifiers via this endpoint.
        contributorUserId: requesterId && c.contributorUserId === requesterId
          ? c.contributorUserId
          : null,
        // Confidence lets iOS de-emphasize weakly-verified entries in
        // the list (lower opacity, footnote, etc.).
        confidence: typeof c.confidence === "number" ? c.confidence : null,
      }));

    res.json({ count: comps.length, sales });
  } catch (err) { next(err); }
});

export default router;

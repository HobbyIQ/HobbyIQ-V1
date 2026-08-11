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
import { requireRateLimited } from "../middleware/requireRateLimited.js";
import { readCompsByCardId } from "../services/portfolioiq/soldCompsStore.service.js";

const router = Router();

async function resolveRequestingUserId(req: Request): Promise<string | null> {
  if (req.user?.userId) return req.user.userId;
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) return null;
  const user = await getUserBySession(sessionId);
  return user?.userId ?? null;
}

router.get("/cards/:cardId/recent-sales", requireSession, requireRateLimited("priceChecksPerDay"), async (req: Request, res: Response, next) => {
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

    // CF-RECENT-SALES-TIER-DEFAULT-RAW (Drew, 2026-08-06). Previous
    // behavior: when the caller didn't send gradeCompany + gradeValue,
    // the service applied NO grade filter, so a Raw card page showed
    // PSA 10s + PSA 9s + Raw all mixed together. The 2018 Topps Chrome
    // Ohtani #150 Refractor recent-comps panel had a $6,500 PSA 10
    // sale next to $3,500 Raw sales, pulling the median up.
    //
    // Fix: when neither param is provided AND caller didn't opt in to
    // "?tier=all", default to Raw filter (both fields null → matches
    // docs with null grade fields). Callers wanting a mixed-tier view
    // can pass ?tier=all explicitly.
    const tierParam = typeof req.query.tier === "string" ? req.query.tier.trim().toLowerCase() : "";
    const hasExplicitCompany = typeof req.query.gradeCompany === "string" && req.query.gradeCompany.trim().length > 0;
    const hasExplicitValue = typeof req.query.gradeValue === "string" && req.query.gradeValue.trim().length > 0;
    let gradeCompany: string | null | undefined;
    let gradeValue: number | null | undefined;
    if (hasExplicitCompany || hasExplicitValue) {
      gradeCompany = hasExplicitCompany ? (req.query.gradeCompany as string).trim() : undefined;
      gradeValue = hasExplicitValue ? Number(req.query.gradeValue) : undefined;
    } else if (tierParam === "all") {
      // Explicit opt-out — no grade filter, mix all tiers.
      gradeCompany = undefined;
      gradeValue = undefined;
    } else {
      // Default: Raw only.
      gradeCompany = null;
      gradeValue = null;
    }

    const daysRaw = typeof req.query.days === "string" ? Number(req.query.days) : NaN;
    const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365 ? daysRaw : 180;

    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? Math.floor(limitRaw) : 25;

    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const rawComps = await readCompsByCardId({
      cardId,
      fromDate,
      // sources: undefined → all sources (user + CH + CS + browse-ended)
      parallel: parallel !== undefined ? parallel : undefined,
      gradeCompany: gradeCompany,
      gradeValue: gradeValue,
      // CF-EXCLUDE-SELF-COMPS (Drew, 2026-08-04). Don't surface the
      // requester's own eBay purchases back to them as market "comps"
      // — see Bobby Witt Jr. BGS 9.5 case where the sole $1,260
      // ebay-user-purchase row was pushing median = purchase price.
      excludeContributorUserId: requesterId,
    });

    // CF-RECENT-SALES-DEDUP (Drew, 2026-08-06). CardHedge occasionally
    // ingests the SAME eBay sale twice via two code paths (raw CH API
    // + ch_daily_sales), producing duplicate rows with the same
    // (source, sourceExternalId) OR the same (contentHash) OR the
    // same (price, soldAt-day). Ohtani Refractor #150 Raw had 4 dup
    // pairs in 30d. Dedup at display time.
    const seenDedupKeys = new Set<string>();
    const dedupedComps: typeof rawComps = [];
    for (const c of rawComps) {
      const ext = (c as { sourceExternalId?: string }).sourceExternalId ?? "";
      const contentHash = (c as { contentHash?: string }).contentHash ?? "";
      const priceDay = `${c.price}|${String(c.soldAt ?? "").slice(0, 10)}`;
      const priceParDay = `${priceDay}|${String(c.parallel ?? "").toLowerCase()}`;
      const keys = [
        contentHash ? `hash:${contentHash}` : "",
        ext ? `ext:${c.source}:${ext}` : "",
        `pd:${priceParDay}`,
      ].filter(Boolean);
      // Skip if we've seen ANY of this row's fingerprint keys already.
      if (keys.some((k) => seenDedupKeys.has(k))) continue;
      keys.forEach((k) => seenDedupKeys.add(k));
      dedupedComps.push(c);
    }

    // CF-RECENT-SALES-PRICE-GATE (Drew, 2026-08-06; per-tier fix 2026-08-10).
    // Drop extreme-outlier rows (< median/3 or > median*3) WITHIN EACH
    // grade tier. Prior version computed one global median across all
    // grades, so on a card dominated by Raw comps (159 Raw + 13 graded),
    // median≈$2.50 and every PSA 10 at $115+ got gated out as "outlier"
    // — invisible in Recent Comps. Now: bucket by grade first, gate
    // within bucket, re-merge. Buckets with <5 comps skip the gate (too
    // small for a reliable median).
    function gradeKey(c: { gradeCompany?: string | null; gradeValue?: number | null }): string {
      if (c.gradeCompany && String(c.gradeCompany).trim().length > 0) {
        return `${String(c.gradeCompany).toUpperCase()} ${c.gradeValue ?? ""}`.trim();
      }
      return "Raw";
    }
    const gateBuckets = new Map<string, typeof dedupedComps>();
    for (const c of dedupedComps) {
      const k = gradeKey(c);
      const arr = gateBuckets.get(k) ?? [];
      arr.push(c);
      gateBuckets.set(k, arr);
    }
    const gatedComps: typeof dedupedComps = [];
    for (const [, rows] of gateBuckets) {
      const prices = rows.map((c) => Number(c.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
      if (prices.length < 5) {
        gatedComps.push(...rows);
        continue;
      }
      const gateMedian = prices[Math.floor(prices.length / 2)];
      const low = gateMedian / 3;
      const high = gateMedian * 3;
      for (const c of rows) {
        const p = Number(c.price);
        if (Number.isFinite(p) && p >= low && p <= high) gatedComps.push(c);
      }
    }
    // Restore newest-first order (readCompsByCardId returns sorted; the
    // bucketed re-merge above scrambles it).
    gatedComps.sort((a, b) => String(b.soldAt ?? "").localeCompare(String(a.soldAt ?? "")));

    const sales = gatedComps
      .slice(0, limit)
      .map((c) => ({
        // CF-USER-FLAG-IDS (Drew, 2026-08-01). Row id + partition key
        // (cardId) needed so a user-flag click can call
        // POST /api/user/flag-comp with {rowId, cardId}.
        id: (c as { id?: string }).id ?? null,
        cardId: c.cardId ?? null,
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
        // CF-CONFIDENCE-EXPLAIN (Drew, 2026-08-01). Persisted at ingest
        // by recordSoldComp. Includes 0-1 score, band, and top signals.
        confidenceScore: (c as { __confidenceScore?: number }).__confidenceScore ?? null,
        confidenceBand: (c as { __confidenceBand?: string }).__confidenceBand ?? null,
        confidenceExplain: (c as { __confidenceExplain?: string }).__confidenceExplain ?? null,
      }));

    // CF-RECENT-SALES-BY-GRADE (Drew, 2026-07-19). Comp Sheet UX groups
    // sales by grade tier so iOS can render tabs (RAW | PSA 10 | PSA 9
    // | BGS 9.5 | ...) each showing only that tier's sales. Also
    // returns per-tier summary stats for the "PSA 9: 6 sales @
    // $875-$1,300 median $1,026 (30d)" shareable format.
    //
    // Tabs are only rendered for tiers with ≥1 sale. Order: Raw first,
    // then descending by grade value.
    const graderBuckets = new Map<string, typeof sales>();
    for (const s of sales) {
      const key = s.gradeCompany && String(s.gradeCompany).trim().length > 0
        ? `${String(s.gradeCompany).toUpperCase()} ${s.gradeValue ?? ""}`.trim()
        : "Raw";
      const arr = graderBuckets.get(key) ?? [];
      arr.push(s);
      graderBuckets.set(key, arr);
    }

    function summarize(rows: typeof sales) {
      const prices = rows.map((r) => r.price).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
      if (prices.length === 0) return { count: 0, min: null, max: null, median: null };
      const median = prices[Math.floor(prices.length / 2)];
      return {
        count: prices.length,
        min: Math.round(prices[0] * 100) / 100,
        max: Math.round(prices[prices.length - 1] * 100) / 100,
        median: Math.round(median * 100) / 100,
      };
    }

    // Deterministic order: Raw first, then graded tiers desc by value.
    const graderOrder = [...graderBuckets.keys()].sort((a, b) => {
      if (a === "Raw") return -1;
      if (b === "Raw") return 1;
      const av = Number(a.split(" ")[1] ?? 0);
      const bv = Number(b.split(" ")[1] ?? 0);
      return bv - av;
    });

    const byGrade = graderOrder.map((grader) => {
      const rows = graderBuckets.get(grader) ?? [];
      return {
        grader,
        ...summarize(rows),
        sales: rows,
      };
    });

    res.json({
      count: gatedComps.length,
      windowDays: days,
      sales,           // backwards-compat: flat list preserved
      byGrade,         // new: grouped by grade tier for the Comp Sheet UI
    });
  } catch (err) { next(err); }
});

export default router;

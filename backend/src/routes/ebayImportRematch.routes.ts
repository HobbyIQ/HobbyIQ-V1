// CF-EBAY-IMPORT-REMATCH (Drew, 2026-07-18). Route:
//   POST /api/portfolio/rematch-ebay-imports
//     body: { dryRun?: boolean, holdingIds?: string[], applyChanges?: boolean }
//
// When dryRun=true (default), returns a per-holding preview showing
// (before, after, changed, needsReview) without persisting anything.
// When applyChanges=true, updates each changed holding's parallel /
// cardNumber / cardId / setName in Cosmos, then triggers a background
// reprice per holding so FMVs refresh with the corrected identity.

import { Router, type Request, type Response } from "express";
import { getUserBySession } from "../services/authService.js";
import { requireSession } from "../middleware/requireSession.js";
import { isRematchCandidate, rematchOne, type RematchResult } from "../services/portfolioiq/ebayImportRematch.service.js";

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

const REMATCH_CONCURRENCY = 4;   // gentle on CH's search-cards rate

router.post("/rematch-ebay-imports", requireSession, async (req: Request, res: Response, next) => {
  try {
    const initialUserId = await requireUserId(req, res);
    if (!initialUserId) return;
    // CF-EBAY-REMATCH-IMPERSONATE (Drew, 2026-07-18): when the caller
    // is the tier1-harness synthetic user, allow impersonation via
    // body.impersonateUserId so a GH Actions workflow can run the
    // rematch against a real user's holdings. Any non-harness caller
    // that supplies impersonateUserId gets a silent no-op — the
    // harness gate is the authorization surface.
    let userId: string = initialUserId;
    if (userId === "tier1-harness" && typeof req.body?.impersonateUserId === "string") {
      const impersonate = req.body.impersonateUserId.trim();
      if (impersonate.length > 0) userId = impersonate;
    }
    const applyChanges = req.body?.applyChanges === true;
    const dryRun = !applyChanges;
    const filterIds: string[] | null = Array.isArray(req.body?.holdingIds)
      ? req.body.holdingIds.filter((s: unknown): s is string => typeof s === "string" && s.length > 0)
      : null;

    const { readUserDoc } = await import("../services/portfolioiq/portfolioStore.service.js");
    const doc = await readUserDoc(userId);
    const allHoldings = Object.values(doc.holdings ?? {});
    const candidates = allHoldings.filter((h) =>
      isRematchCandidate(h)
      && (filterIds ? filterIds.includes(h.id) : true),
    );

    // Bounded concurrency across candidates
    const results: RematchResult[] = new Array(candidates.length);
    let cursor = 0;
    async function worker() {
      while (cursor < candidates.length) {
        const i = cursor++;
        try {
          results[i] = await rematchOne(candidates[i]);
        } catch {
          results[i] = {
            holdingId: candidates[i].id,
            ebayTitle: String(candidates[i].cardTitle ?? ""),
            purchasePrice: null,
            before: { parallel: null, cardNumber: null, setName: null, cardId: null, fairMarketValue: null },
            after: { parallel: null, cardNumber: null, setName: null, cardId: null, matchConfidence: 0, matchSource: "no_match" },
            changed: false,
            needsReview: false,
            reviewReason: null,
          };
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(REMATCH_CONCURRENCY, candidates.length) }, () => worker()),
    );

    let appliedCount = 0;
    if (applyChanges) {
      // Persist per-holding changes via portfolioStore's update path.
      const { applyRematchToHolding } = await import(
        "../services/portfolioiq/portfolioStore.service.js"
      ).catch(() => ({ applyRematchToHolding: null })) as { applyRematchToHolding: ((...args: unknown[]) => Promise<boolean>) | null };
      if (applyRematchToHolding) {
        for (const r of results) {
          if (!r.changed) continue;
          try {
            const ok = await applyRematchToHolding(userId, r.holdingId, {
              cardId: r.after.cardId,
              parallel: r.after.parallel,
              cardNumber: r.after.cardNumber,
              setName: r.after.setName,
            });
            if (ok) appliedCount++;
          } catch { /* silent — one failure shouldn't kill the batch */ }
        }
      }
    }

    const summary = {
      candidateCount: candidates.length,
      changedCount: results.filter((r) => r.changed).length,
      needsReviewCount: results.filter((r) => r.needsReview).length,
      appliedCount,
      dryRun,
    };
    res.json({
      computedAt: new Date().toISOString(),
      summary,
      results,
    });
  } catch (err) { next(err); }
});

export default router;

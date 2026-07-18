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
      const { applyRematchToHolding, readUserDoc } = await import(
        "../services/portfolioiq/portfolioStore.service.js"
      ).catch(() => ({ applyRematchToHolding: null, readUserDoc: null })) as {
        applyRematchToHolding: ((...args: unknown[]) => Promise<boolean>) | null;
        readUserDoc: ((userId: string) => Promise<{ holdings: Record<string, unknown> }>) | null;
      };
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
            if (ok) {
              appliedCount++;
              // CF-EBAY-PURCHASE-COMP (Drew, 2026-07-18): once we've
              // validated the identity via strict-mode + price-validator
              // AND persisted the corrected cardId, emit an
              // ebay-user-purchase sold_comp so this real transaction
              // shows up in the pool for downstream pricing (Drew:
              // "if there are no comps, we should add the ebay pull in
              // comps since they are real data"). Mirrors the confirm-
              // flow emit in ebayReviewQueue.service.ts:267-293 —
              // fire-and-forget, swallow errors, never block the apply.
              if (r.after.cardId && r.purchasePrice && r.purchasePrice > 0 && readUserDoc) {
                void (async () => {
                  try {
                    const doc = await readUserDoc(userId);
                    const holding = (doc.holdings as Record<string, unknown>)[r.holdingId]
                      ?? Object.values(doc.holdings).find((h) =>
                        (h as { id?: string }).id === r.holdingId,
                      );
                    if (!holding) return;
                    const h = holding as Record<string, unknown>;
                    const playerName = String(h.playerName ?? "").trim();
                    if (!playerName) return;
                    const soldAt = String(
                      h.purchaseDate
                      ?? h.addedAt
                      ?? h.confirmedAt
                      ?? new Date().toISOString(),
                    );
                    const { recordSoldComp } = await import(
                      "../services/portfolioiq/soldCompsStore.service.js"
                    );
                    await recordSoldComp({
                      cardId: r.after.cardId!,
                      playerName,
                      cardYear: (h.cardYear as number | null) ?? null,
                      setName: r.after.setName ?? null,
                      parallel: r.after.parallel ?? null,
                      cardNumber: r.after.cardNumber ?? null,
                      isAuto: h.isAuto === true,
                      price: r.purchasePrice!,
                      soldAt,
                      source: "ebay-user-purchase",
                      sourceExternalId: (h.ebayItemId as string | null) ?? `rematch::${r.holdingId}`,
                      contributorUserId: userId,
                      title: r.ebayTitle ?? null,
                      imageUrl: (h.ebayImageUrl as string | null) ?? null,
                      sellerHandle: null,
                      // NOT user-verified (Drew hasn't manually confirmed);
                      // the identity comes from the matcher's strict-mode
                      // + price-validator survivors, which carry a 0.8
                      // matchConfidence from CH's search.
                      verifiedByUser: false,
                      confidence: r.after.matchConfidence ?? 0.8,
                    });
                  } catch {
                    // swallow — comp emission is auxiliary
                  }
                })();
              }
            }
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

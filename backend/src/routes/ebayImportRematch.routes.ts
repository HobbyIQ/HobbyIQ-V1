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
import { requireAdmin } from "../middleware/requireAdmin.js";
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
    // CF-EBAY-PURCHASE-COMP-BACKFILL (Drew, 2026-07-18): when
    // emitBackfill=true, emit ebay-user-purchase comps for every
    // candidate holding with a valid cardId + purchase price, even
    // when the matcher says nothing changed. Used to backfill the
    // pool for holdings applied under earlier PRs (#558, this
    // session's v4 apply) that predate the emit gate. Idempotent
    // via recordSoldComp's {source}::{sourceExternalId} dedup.
    const emitBackfill = req.body?.emitBackfill === true;
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
          // Normal apply flow only runs against changed proposals;
          // emitBackfill mode iterates all candidates to seed comps
          // for holdings that were corrected under earlier PRs.
          if (!r.changed && !emitBackfill) continue;
          try {
            if (r.changed) {
              const ok = await applyRematchToHolding(userId, r.holdingId, {
                cardId: r.after.cardId,
                parallel: r.after.parallel,
                cardNumber: r.after.cardNumber,
                setName: r.after.setName,
              });
              if (ok) appliedCount++;
            }
            // CF-EBAY-PURCHASE-COMP (Drew, 2026-07-18): emit an
            // ebay-user-purchase sold_comp whenever the matcher proposed
            // a change (r.changed=true), regardless of whether apply
            // actually persisted a delta this call. Re-runs against
            // already-corrected holdings still want their comp in the
            // pool; recordSoldComp is idempotent on
            // {source}::{sourceExternalId}, so double-emits are safe.
            // Mirrors the confirm-flow emit in
            // ebayReviewQueue.service.ts:267-293 — fire-and-forget,
            // swallow errors, never block the apply.
            {
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
                      gradeCompany: (h.gradeCompany as string | null) ?? null,
                      gradeValue: (h.gradeValue as number | null) ?? null,
                      price: r.purchasePrice!,
                      soldAt,
                      source: "ebay-user-purchase",
                      // CF-COMP-DEDUP-CANONICAL (Drew, 2026-07-18): use a
                      // holding-scoped fallback so re-emissions from any path
                      // (confirm/rematch/suggester/backfill) upsert to the
                      // same doc when ebayItemId is absent. Prevents the
                      // 3-5×-per-holding duplicates seen in Drew's pool.
                      sourceExternalId: (h.ebayItemId as string | null) ?? `holding::${r.holdingId}`,
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

// CF-EBAY-PURCHASE-COMP-BATCH-ADMIN (Drew, 2026-07-18). Batch admin
// backfill that sweeps EVERY user's ebay-imported holdings through the
// rematch service and fires ebay-user-purchase comp emits for each
// holding with a valid cardId + purchase price. This seeds the shared
// sold_comps pool from every existing user's historical purchases in
// one pass — the "fill our backend to be self sufficient" motion.
//
// Auth: requireAdmin (Bearer <ADMIN_API_TOKEN>).
//
// body:
//   {
//     dryRun?: boolean,      // default true; when false, emits comps
//     maxUsers?: number,     // default 500; caps the sweep for safety
//     concurrency?: number,  // default 2; per-user parallelism
//   }
//
// Response summary shape:
//   {
//     usersProcessed, usersWithCandidates, totalCandidates,
//     totalCompsEmittedApprox, errors, dryRun
//   }
//
// The emit itself is fire-and-forget via recordSoldComp; idempotent on
// {source}::{sourceExternalId} so re-running is safe. totalComps is an
// approximation because the emits are async and we return immediately
// after firing them.

// CF-USER-MANUAL-COMP-ADD (Drew, 2026-07-18). User-facing "I saw this
// sell for $X on YYYY-MM-DD" entry point. Session-authed mirror of
// /admin/comps/add. Same recordSoldComp writer, same idempotency, but
// contributorUserId is forced to req.user.userId so we can attribute
// (and rate-limit / trust-score) per-user contributions. Confidence
// default lowered to 0.75 (vs admin 0.9) because we don't validate
// user-supplied listings the way admin does — the pool still boosts
// direct comps regardless.
//
// Route: POST /api/portfolio/manual-comps/add
// Auth:  requireSession
// Body:
//   {
//     cardId: string,
//     playerName: string,
//     price: number,
//     soldAt: ISO string,
//     cardYear?, setName?, parallel?, cardNumber?, isAuto?, gradeCompany?, gradeValue?,
//     sourceExternalId?, title?
//   }
router.post("/manual-comps/add", requireSession, async (req: Request, res: Response, next) => {
  try {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    const { recordSoldComp } = await import(
      "../services/portfolioiq/soldCompsStore.service.js"
    );
    const b = req.body ?? {};
    const cardId = String(b.cardId ?? "").trim();
    const playerName = String(b.playerName ?? "").trim();
    const price = Number(b.price);
    const soldAt = String(b.soldAt ?? "").trim();
    if (!cardId || !playerName || !(price > 0) || !soldAt) {
      res.status(400).json({
        success: false,
        error: "cardId, playerName, price (>0), and soldAt required",
      });
      return;
    }
    // Sanity: reject sales dated in the future (>1d clock skew guard).
    const soldAtMs = Date.parse(soldAt);
    if (!Number.isFinite(soldAtMs)) {
      res.status(400).json({ success: false, error: "soldAt must be a parseable date" });
      return;
    }
    if (soldAtMs > Date.now() + 24 * 60 * 60 * 1000) {
      res.status(400).json({ success: false, error: "soldAt cannot be in the future" });
      return;
    }
    const sourceExternalId = typeof b.sourceExternalId === "string" && b.sourceExternalId.trim().length > 0
      ? b.sourceExternalId.trim()
      : `manual-user-${userId}::${cardId}::${soldAtMs}::${Math.round(price * 100)}`;
    await recordSoldComp({
      cardId,
      playerName,
      cardYear: typeof b.cardYear === "number" ? b.cardYear : null,
      setName: typeof b.setName === "string" ? b.setName : null,
      parallel: typeof b.parallel === "string" ? b.parallel : null,
      cardNumber: typeof b.cardNumber === "string" ? b.cardNumber : null,
      isAuto: b.isAuto === true,
      gradeCompany: typeof b.gradeCompany === "string" ? b.gradeCompany : null,
      gradeValue: typeof b.gradeValue === "number" ? b.gradeValue : null,
      price,
      soldAt,
      source: "manual-user-entry",
      sourceExternalId,
      contributorUserId: userId,
      title: typeof b.title === "string" ? b.title : null,
      imageUrl: null,
      sellerHandle: null,
      verifiedByUser: true,        // user attested via manual add
      confidence: 0.75,            // lower than admin 0.9 (unverified provenance)
    });
    res.json({ success: true, sourceExternalId, cardId, price, soldAt });
  } catch (err) { next(err); }
});

router.post("/admin/rematch-ebay-imports/batch-backfill", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const dryRun = req.body?.dryRun !== false;
    const maxUsers = Math.max(1, Math.min(2000, Number(req.body?.maxUsers ?? 500)));
    const perUserConcurrency = Math.max(1, Math.min(4, Number(req.body?.concurrency ?? 2)));

    const { readUserDoc, listAllPortfolioUserIds } = await import(
      "../services/portfolioiq/portfolioStore.service.js"
    );
    const allUserIds = (await listAllPortfolioUserIds()).slice(0, maxUsers);

    const summary = {
      usersProcessed: 0,
      usersWithCandidates: 0,
      totalCandidates: 0,
      totalCompsEmittedApprox: 0,
      errors: 0,
      dryRun,
    };

    for (const userId of allUserIds) {
      summary.usersProcessed++;
      try {
        const doc = await readUserDoc(userId);
        const holdings = Object.values(doc.holdings ?? {}).filter(isRematchCandidate);
        if (holdings.length === 0) continue;
        summary.usersWithCandidates++;
        summary.totalCandidates += holdings.length;

        const results: RematchResult[] = new Array(holdings.length);
        let cursor = 0;
        async function worker() {
          while (cursor < holdings.length) {
            const i = cursor++;
            try { results[i] = await rematchOne(holdings[i]); } catch { /* silent */ }
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(perUserConcurrency, holdings.length) }, () => worker()),
        );

        if (dryRun) continue;

        // Emit comps for every holding with a valid post-match cardId
        // + purchase price. This is intentionally NOT gated on r.changed
        // — the backfill is FOR already-corrected holdings that need
        // their comp seeded.
        const { recordSoldComp } = await import(
          "../services/portfolioiq/soldCompsStore.service.js"
        );
        for (const r of results) {
          if (!r) continue;
          if (!r.after?.cardId || !r.purchasePrice || r.purchasePrice <= 0) continue;
          const holdingsMap = doc.holdings as Record<string, unknown>;
          const holding = holdingsMap[r.holdingId]
            ?? Object.values(holdingsMap).find((h) => (h as { id?: string }).id === r.holdingId);
          if (!holding) continue;
          const h = holding as Record<string, unknown>;
          const playerName = String(h.playerName ?? "").trim();
          if (!playerName) continue;
          const soldAt = String(
            h.purchaseDate
            ?? h.addedAt
            ?? h.confirmedAt
            ?? new Date().toISOString(),
          );
          void (async () => {
            try {
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
                sourceExternalId: (h.ebayItemId as string | null) ?? `holding::${r.holdingId}`,
                contributorUserId: userId,
                title: r.ebayTitle ?? null,
                imageUrl: (h.ebayImageUrl as string | null) ?? null,
                sellerHandle: null,
                verifiedByUser: false,
                confidence: r.after.matchConfidence ?? 0.8,
              });
            } catch { /* per-holding failures never block the sweep */ }
          })();
          summary.totalCompsEmittedApprox++;
        }
      } catch {
        summary.errors++;
      }
    }

    res.json({
      computedAt: new Date().toISOString(),
      summary,
    });
  } catch (err) { next(err); }
});

// CF-EBAY-PURCHASE-COMP-LIST (Drew, 2026-07-18). Admin endpoint that
// lists the sold_comps we've emitted for a user's inventory. Walks
// the user's holdings, groups by cardId, and pulls all sold_comps per
// cardId (default 180d window). Useful for sanity-checking that the
// suggester/rematch/backfill paths actually landed comps in the pool.
//
// Auth: requireAdmin.
// body: { userId: string, sources?: string[] }
router.post("/admin/list-user-comps", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const userId = String(req.body?.userId ?? "").trim();
    if (!userId) {
      res.status(400).json({ error: "Missing userId in body" });
      return;
    }
    const sources = Array.isArray(req.body?.sources)
      ? req.body.sources.filter((s: unknown): s is string => typeof s === "string")
      : ["ebay-user-purchase", "ebay-user-sale", "manual-user-entry"];

    const { readUserDoc } = await import("../services/portfolioiq/portfolioStore.service.js");
    const { readCompsByCardId } = await import("../services/portfolioiq/soldCompsStore.service.js");
    const doc = await readUserDoc(userId);
    const holdings = Object.values(doc.holdings ?? {}) as unknown as Array<Record<string, unknown>>;

    // Unique cardIds across the inventory.
    const cardIdSet = new Set<string>();
    for (const h of holdings) {
      const cid = String(h.cardId ?? "").trim();
      if (cid.length > 0) cardIdSet.add(cid);
    }

    // Pull comps for each cardId in parallel (bounded).
    const cardIds = Array.from(cardIdSet);
    const results: Array<{
      cardId: string;
      holdingsRefCount: number;
      compCount: number;
      comps: Array<{
        source: string;
        price: number;
        soldAt: string;
        contributorUserId: string | null;
        title: string | null;
        parallel: string | null;
        cardNumber: string | null;
        verifiedByUser: boolean;
        confidence: number | null;
      }>;
    }> = new Array(cardIds.length);
    let cursor = 0;
    async function worker() {
      while (cursor < cardIds.length) {
        const i = cursor++;
        const cid = cardIds[i];
        try {
          const comps = await readCompsByCardId({ cardId: cid, sources: sources as never });
          results[i] = {
            cardId: cid,
            holdingsRefCount: holdings.filter((h) => String(h.cardId ?? "") === cid).length,
            compCount: comps.length,
            comps: comps.map((c) => ({
              source: c.source,
              price: c.price,
              soldAt: c.soldAt,
              contributorUserId: c.contributorUserId ?? null,
              title: (c as { title?: string | null }).title ?? null,
              parallel: (c as { parallel?: string | null }).parallel ?? null,
              cardNumber: (c as { cardNumber?: string | null }).cardNumber ?? null,
              verifiedByUser: (c as { verifiedByUser?: boolean }).verifiedByUser === true,
              confidence: (c as { confidence?: number | null }).confidence ?? null,
            })),
          };
        } catch {
          results[i] = { cardId: cid, holdingsRefCount: 0, compCount: 0, comps: [] };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, cardIds.length) }, () => worker()));

    const summary = {
      inventoryHoldingCount: holdings.length,
      uniqueCardIds: cardIds.length,
      cardIdsWithAtLeastOneComp: results.filter((r) => r.compCount > 0).length,
      totalCompsAcrossInventory: results.reduce((sum, r) => sum + r.compCount, 0),
    };

    res.json({
      computedAt: new Date().toISOString(),
      userId,
      sources,
      summary,
      results: results.sort((a, b) => b.compCount - a.compCount),
    });
  } catch (err) { next(err); }
});

// CF-COMP-DEDUP-CLEANUP (Drew, 2026-07-18). One-time admin endpoint
// that finds duplicate sold_comp docs and collapses them. Duplicates
// exist because pre-PR #579 emit paths (rematch, suggester, batch-
// backfill) used different sourceExternalId prefixes for the same
// holding, producing 3-5 docs per real transaction.
//
// Dedup key: (cardId, source, contributorUserId, price rounded to
// cents, soldAt truncated to day). Keeps the doc with the highest
// confidence (or newest observedAt as tiebreak); soft-flags the
// others with flaggedWrong=true so the engine skips them but
// provenance is preserved.
//
// Auth: requireAdmin.
// Body: { userId?: string, dryRun?: boolean }
router.post("/admin/dedup-user-comps", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const targetUserId = typeof req.body?.userId === "string" ? req.body.userId.trim() : null;
    const dryRun = req.body?.dryRun !== false;

    const { readUserDoc, listAllPortfolioUserIds } = await import(
      "../services/portfolioiq/portfolioStore.service.js"
    );
    const { readCompsByCardId, flagCompAsWrong } = await import(
      "../services/portfolioiq/soldCompsStore.service.js"
    );

    const userIds = targetUserId ? [targetUserId] : await listAllPortfolioUserIds();

    let cardIdsScanned = 0;
    let duplicateGroupsFound = 0;
    let compsFlagged = 0;
    const examples: Array<{ cardId: string; kept: string; flagged: string[] }> = [];

    for (const userId of userIds) {
      let doc;
      try { doc = await readUserDoc(userId); } catch { continue; }
      const holdings = Object.values(doc.holdings ?? {}) as unknown as Array<Record<string, unknown>>;
      const cardIdSet = new Set<string>();
      for (const h of holdings) {
        const cid = String(h.cardId ?? "").trim();
        if (cid) cardIdSet.add(cid);
      }

      for (const cardId of cardIdSet) {
        cardIdsScanned++;
        const comps = await readCompsByCardId({ cardId }).catch(() => [] as Awaited<ReturnType<typeof readCompsByCardId>>);
        // Group by dedup key
        const groups = new Map<string, typeof comps>();
        for (const c of comps) {
          const day = (c.soldAt ?? "").slice(0, 10);
          const priceCents = Math.round(c.price * 100);
          const key = `${c.source}|${c.contributorUserId ?? "_"}|${priceCents}|${day}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(c);
        }
        for (const [, group] of groups) {
          if (group.length < 2) continue;
          duplicateGroupsFound++;
          // Sort: highest confidence first, then newest observedAt.
          group.sort((a, b) => {
            const dc = (b.confidence ?? 0) - (a.confidence ?? 0);
            if (dc !== 0) return dc;
            return Date.parse(b.observedAt ?? "") - Date.parse(a.observedAt ?? "");
          });
          const kept = group[0];
          const flaggedIds: string[] = [];
          for (let i = 1; i < group.length; i++) {
            const dupe = group[i];
            if (!dryRun) {
              try {
                await flagCompAsWrong({
                  compId: dupe.id,
                  cardId,
                  flaggedByUserId: "system-dedup",
                  reason: `duplicate of ${kept.id} (auto-collapsed)`,
                });
                compsFlagged++;
              } catch { /* silent */ }
            } else {
              compsFlagged++;
            }
            flaggedIds.push(dupe.id);
          }
          if (examples.length < 10) {
            examples.push({ cardId, kept: kept.id, flagged: flaggedIds });
          }
        }
      }
    }

    res.json({
      computedAt: new Date().toISOString(),
      dryRun,
      summary: {
        usersScanned: userIds.length,
        cardIdsScanned,
        duplicateGroupsFound,
        compsFlagged,
      },
      examples,
    });
  } catch (err) { next(err); }
});

// CF-MANUAL-COMP-ADD (Drew, 2026-07-18). Admin endpoint to inject a
// sold_comp we know about but haven't automated ingestion for yet.
// Common case: user saw a $1,500 sale on eBay that CH's feed missed;
// we add it manually so it anchors the FMV pool immediately.
//
// Auth: requireAdmin.
// Body:
//   {
//     cardId: string,               // required
//     playerName: string,           // required
//     price: number,                // required, > 0
//     soldAt: string,               // ISO date; required
//     parallel?: string,
//     cardNumber?: string,
//     setName?: string,
//     cardYear?: number,
//     isAuto?: boolean,
//     gradeCompany?: string | null,
//     gradeValue?: number | null,
//     title?: string,               // e.g. eBay listing title
//     sourceExternalId?: string,    // eBay itemId; else auto-generated
//     verifiedByUser?: boolean,     // default true (manual = attested)
//     confidence?: number,          // default 0.9
//     contributorUserId?: string,   // default "admin-manual"
//   }
router.post("/admin/comps/add", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const { recordSoldComp } = await import(
      "../services/portfolioiq/soldCompsStore.service.js"
    );
    const b = req.body ?? {};
    const cardId = String(b.cardId ?? "").trim();
    const playerName = String(b.playerName ?? "").trim();
    const price = Number(b.price);
    const soldAt = String(b.soldAt ?? "").trim();
    if (!cardId || !playerName || !(price > 0) || !soldAt) {
      res.status(400).json({
        success: false,
        error: "cardId, playerName, price (>0), and soldAt required",
      });
      return;
    }
    const sourceExternalId = typeof b.sourceExternalId === "string" && b.sourceExternalId.trim().length > 0
      ? b.sourceExternalId.trim()
      : `admin-manual::${cardId}::${Date.parse(soldAt) || Date.now()}::${Math.round(price * 100)}`;
    await recordSoldComp({
      cardId,
      playerName,
      cardYear: typeof b.cardYear === "number" ? b.cardYear : null,
      setName: typeof b.setName === "string" ? b.setName : null,
      parallel: typeof b.parallel === "string" ? b.parallel : null,
      cardNumber: typeof b.cardNumber === "string" ? b.cardNumber : null,
      isAuto: b.isAuto === true,
      gradeCompany: typeof b.gradeCompany === "string" ? b.gradeCompany : null,
      gradeValue: typeof b.gradeValue === "number" ? b.gradeValue : null,
      price,
      soldAt,
      source: "manual-user-entry",
      sourceExternalId,
      contributorUserId: typeof b.contributorUserId === "string" ? b.contributorUserId : "admin-manual",
      title: typeof b.title === "string" ? b.title : null,
      imageUrl: null,
      sellerHandle: null,
      verifiedByUser: b.verifiedByUser !== false,   // default true
      confidence: typeof b.confidence === "number" ? b.confidence : 0.9,
    });
    res.json({ success: true, sourceExternalId, cardId, price, soldAt });
  } catch (err) { next(err); }
});

// CF-SELL-SIDE-NOTIFY (Drew, 2026-07-18). Admin trigger for the
// sell-side notify job. Fires via GH Actions nightly cron; also
// manually dispatchable for testing.
//
// Auth: requireAdmin.
// Body: { dryRun?: boolean, liftThresholdPct?: number, perUserDailyCap?: number }
router.post("/admin/sell-side-notify/run", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const { runSellSideNotifyJob } = await import(
      "../services/portfolioiq/sellSideNotifyJob.service.js"
    );
    const summary = await runSellSideNotifyJob({
      dryRun: req.body?.dryRun === true,
      liftThresholdPct: typeof req.body?.liftThresholdPct === "number" ? req.body.liftThresholdPct : undefined,
      perUserDailyCap: typeof req.body?.perUserDailyCap === "number" ? req.body.perUserDailyCap : undefined,
      perHoldingCooldownHours: typeof req.body?.perHoldingCooldownHours === "number" ? req.body.perHoldingCooldownHours : undefined,
      dismissCooldownDays: typeof req.body?.dismissCooldownDays === "number" ? req.body.dismissCooldownDays : undefined,
    });
    res.json({ computedAt: new Date().toISOString(), summary });
  } catch (err) { next(err); }
});

// CF-SUB-RAW-INVERSION-SCAN (Drew, 2026-07-19). Admin trigger for the
// nightly sub-raw inversion scanner. Emits sub_raw_inversion_observed
// telemetry per SKU where a Raw sale exceeds the graded median.
router.post("/admin/sub-raw-inversion/scan", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const { runSubRawInversionScan } = await import(
      "../services/signals/subRawInversionScan.service.js"
    );
    const sport = typeof req.body?.sport === "string" ? req.body.sport : "baseball";
    const summary = await runSubRawInversionScan({
      sport,
      windowDays: typeof req.body?.windowDays === "number" ? req.body.windowDays : undefined,
      minRawSales: typeof req.body?.minRawSales === "number" ? req.body.minRawSales : undefined,
      minGradedSales: typeof req.body?.minGradedSales === "number" ? req.body.minGradedSales : undefined,
      minMarginPct: typeof req.body?.minMarginPct === "number" ? req.body.minMarginPct : undefined,
      dryRun: req.body?.dryRun === true,
    });
    res.json({ computedAt: new Date().toISOString(), summary });
  } catch (err) { next(err); }
});

// CF-GRADE-ARBITRAGE (Drew, 2026-07-19). Admin trigger for the nightly
// grade-arbitrage push job. Fires via GH Actions.
router.post("/admin/grade-arbitrage-notify/run", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const { runGradeArbitrageNotifyJob } = await import(
      "../services/portfolioiq/gradeArbitrageNotifyJob.service.js"
    );
    const summary = await runGradeArbitrageNotifyJob({
      dryRun: req.body?.dryRun === true,
      minUpliftX: typeof req.body?.minUpliftX === "number" ? req.body.minUpliftX : undefined,
      minRawFmvUSD: typeof req.body?.minRawFmvUSD === "number" ? req.body.minRawFmvUSD : undefined,
      perUserDailyCap: typeof req.body?.perUserDailyCap === "number" ? req.body.perUserDailyCap : undefined,
      perHoldingCooldownDays: typeof req.body?.perHoldingCooldownDays === "number" ? req.body.perHoldingCooldownDays : undefined,
      dismissCooldownDays: typeof req.body?.dismissCooldownDays === "number" ? req.body.dismissCooldownDays : undefined,
      sport: typeof req.body?.sport === "string" ? req.body.sport : undefined,
    });
    res.json({ computedAt: new Date().toISOString(), summary });
  } catch (err) { next(err); }
});

// CF-EBAY-IMPORT-ADMIN (Drew, 2026-07-18). Admin-impersonation of
// importEbayPurchaseHistory so ops can trigger a user's eBay purchase
// history sync without their session. Uses the user's stored eBay
// OAuth tokens (attached to their user doc). Same body/summary shape as
// /api/portfolio/erp/purchases/import/ebay.
//
// Auth: requireAdmin.
// Body: { userId: string, days?: number (default 30, max 90) }
router.post("/admin/purchases/import/ebay", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const userId = String(req.body?.userId ?? "").trim();
    if (!userId) {
      res.status(400).json({ error: "userId required" });
      return;
    }
    const days = Number(req.body?.days ?? 30);
    if (!Number.isFinite(days) || days < 1 || days > 90) {
      res.status(400).json({ error: "days must be 1-90" });
      return;
    }
    const { importEbayPurchaseHistory, runAutoHoldingBatch } = await import(
      "../services/ebay/ebayBuyerHistory.service.js"
    );
    const importSummary = await importEbayPurchaseHistory(userId, days);
    // Chain the auto-holding attribution — same as the sequence iOS
    // triggers via the two ERP endpoints, but atomic from the admin
    // caller's perspective.
    const holdingSummary = await runAutoHoldingBatch(userId);
    res.json({
      success: true,
      import: importSummary,
      holdings: {
        processed: holdingSummary.processed,
        created: holdingSummary.created,
        needsReview: holdingSummary.needsReview,
        browseEnriched: holdingSummary.browseEnriched,
        skipped: holdingSummary.skipped,
      },
    });
  } catch (err) { next(err); }
});

export default router;

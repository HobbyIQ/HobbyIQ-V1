// CF-COMMUNITY-INTELLIGENCE (Drew, 2026-07-17). Routes for the
// community signal surface:
//
//   GET  /api/community/consent            — read caller's consent
//   PATCH /api/community/consent           — update caller's consent
//   GET  /api/community/card/:cardId       — return the aggregated
//                                             community signal (holder
//                                             share, cohort turnover,
//                                             consensus predicted price)
//                                             gated by k-anonymity.

import { Router, type Request, type Response } from "express";
import { getUserBySession } from "../services/authService.js";
import { requireSession } from "../middleware/requireSession.js";

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

// ─── Consent ────────────────────────────────────────────────────────
router.get("/consent", requireSession, async (req: Request, res: Response, next) => {
  try {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    const { readConsent } = await import("../services/community/communityConsent.service.js");
    const consent = await readConsent(userId);
    res.json({ success: true, consent });
  } catch (err) { next(err); }
});

router.patch("/consent", requireSession, async (req: Request, res: Response, next) => {
  try {
    const userId = await requireUserId(req, res);
    if (!userId) return;
    const { upsertConsent } = await import("../services/community/communityConsent.service.js");
    const patch: {
      contributeSignal?: boolean;
      shareHoldings?: boolean;
      shareSales?: boolean;
      shareEngineEstimates?: boolean;
    } = {};
    if (typeof req.body?.contributeSignal === "boolean") patch.contributeSignal = req.body.contributeSignal;
    if (typeof req.body?.shareHoldings === "boolean") patch.shareHoldings = req.body.shareHoldings;
    if (typeof req.body?.shareSales === "boolean") patch.shareSales = req.body.shareSales;
    if (typeof req.body?.shareEngineEstimates === "boolean") patch.shareEngineEstimates = req.body.shareEngineEstimates;
    const consent = await upsertConsent(userId, patch);
    res.json({ success: true, consent });
  } catch (err) { next(err); }
});

// ─── Card-level community signal ────────────────────────────────────
router.get("/card/:cardId", requireSession, async (req: Request, res: Response, next) => {
  try {
    const _userId = await requireUserId(req, res);
    if (!_userId) return;
    const cardId = String(req.params.cardId ?? "").trim();
    if (!cardId) return res.status(400).json({ error: "cardId path param required" });

    const [{ countContributorsBy }, { aggregateCommunitySignal }] = await Promise.all([
      import("../services/community/communityConsent.service.js"),
      import("../services/community/communityAggregation.service.js"),
    ]);

    // For MVP wire, holderCount / owner counts / estimates are all
    // zero until the "contribute signal" fanout job populates them.
    // The endpoint returns the k-anonymity-gated response, which
    // means iOS will render "signal not yet available" cleanly.
    //
    // Follow-up: nightly job that walks contributing users'
    // portfolios and aggregates per-cardId counts into a materialized
    // view (community_card_aggregates container), then this endpoint
    // reads that view instead of counting live.
    const totalContributors = await countContributorsBy("shareHoldings");
    const signal = aggregateCommunitySignal({
      cardId,
      holderCount: 0,
      totalContributors,
      soldInWindowCount: 0,
      ownersInWindowCount: 0,
      turnoverWindowDays: 30,
      contributedEstimates: [],
    });
    res.json({
      computedAt: new Date().toISOString(),
      cardId,
      signal,
      // iOS reads this to decide whether to show the "how many pros
      // are contributing?" upsell — invite the user to opt in when
      // pool is small.
      contributorPoolSize: totalContributors,
    });
  } catch (err) { next(err); }
});

export default router;

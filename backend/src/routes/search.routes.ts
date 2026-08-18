// CF-UNIFIED-SEARCH-AND-CERT v1 W3 — POST /api/search/cards.
//
// CF-PAYMENTS-A retrofit: requireSession enforced via middleware. No
// entitlement gate — catalog search is available on all plans (free
// users still need to find a card before deciding to scan/buy). The
// downstream price/estimate endpoints carry the priceChecksPerDay cap
// (Phase B, deferred).
//
// Request:
//   POST /api/search/cards
//   Headers: x-session-id
//   Body:    { input: string, hint?: "cert" | "freetext" }
//
// Response: UnifiedSearchResponse (see backend/src/types/unifiedSearch.ts)

import { Request, Response, Router } from "express";
import { dispatchSearch } from "../services/unifiedSearch/index.js";
import type { UnifiedSearchMode } from "../types/unifiedSearch.js";
import { requireSession } from "../middleware/requireSession.js";

const router = Router();
router.use(requireSession);

router.post("/cards", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    input?: unknown;
    hint?: unknown;
    /** CF-FIX-FLOW-PROVISIONAL (Drew, 2026-08-12). Manual match surfaces
     *  (Pending Review "fix", add-card, eBay import reconciler) send true so
     *  the user can select a PROVISIONAL card — a real card we hold sales
     *  for but have no checklist for yet. Ordinary search omits it and gets
     *  verified cards only. Picking a provisional card writes
     *  source='user-verified', which upgrades that row. */
    includeProvisional?: unknown;
  };
  if (typeof body.input !== "string") {
    res.status(400).json({
      success: false,
      error: "Request body must include `input` (string)",
    });
    return;
  }

  let hint: UnifiedSearchMode | undefined;
  if (body.hint === "cert" || body.hint === "freetext") {
    hint = body.hint;
  } else if (body.hint !== undefined) {
    res.status(400).json({
      success: false,
      error: "`hint` must be either \"cert\" or \"freetext\" when provided",
    });
    return;
  }

  try {
    const response = await dispatchSearch(body.input, hint, {
      includeProvisional: body.includeProvisional === true,
    });
    // CF-CARDSIGHT-RETIRED (Drew, 2026-08-17: "We dont use cardsight to match
    // or anything, that process needs to be removed"). patchCardsightImageUrls
    // filled imageUrl on Cardsight-native candidate rows. With CS out of the
    // matching path the dispatcher no longer produces such rows, so the helper
    // had nothing to patch — and its own kill-switch already made it a no-op
    // whenever CARDSIGHT_API_KEY was unset. Removed with the feature.
    res.json(response);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unified search failed";
    res.status(500).json({ success: false, error: message });
  }
});

export default router;

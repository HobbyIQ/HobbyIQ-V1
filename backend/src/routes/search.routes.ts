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
  const body = (req.body ?? {}) as { input?: unknown; hint?: unknown };
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
    const response = await dispatchSearch(body.input, hint);
    res.json(response);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unified search failed";
    res.status(500).json({ success: false, error: message });
  }
});

export default router;

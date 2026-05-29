// CF-UNIFIED-SEARCH-AND-CERT v1 W3 — POST /api/search/cards.
//
// Per design doc 23038d7 §4. Single endpoint, server-side dispatch.
// Rationale per design: v1.5 grader additions ship as backend-only
// CFs (new service file + adapter + one-line registerCertGrader);
// client-side dispatch would force every grader CF into a coordinated
// backend+iOS commit. Server-side dispatch is the load-bearing
// abstraction enabler.
//
// Request:
//   POST /api/search/cards
//   Headers: x-session-id (session-gated, same pattern as
//            /api/psa/cert/:n at psa.routes.ts:7-21)
//   Body:    { input: string, hint?: "cert" | "freetext" }
//
// Response: UnifiedSearchResponse (see backend/src/types/unifiedSearch.ts)
//
// Status codes:
//   200 — always returned for valid auth + well-formed body, even
//         when zero candidates surfaced. "No candidates" is a
//         semantic outcome (cert not found, free-text no hits), not
//         an HTTP failure. Consumers branch on candidates.length +
//         warnings.
//   400 — body missing or input is not a string
//   401 — missing or invalid x-session-id
//   500 — unhandled error in the dispatcher (should not happen —
//         the dispatcher catches grader failures internally and
//         surfaces them as warnings; freetext path's searchCatalog
//         returns [] on error rather than throwing)

import { Request, Response, Router } from "express";
import { getUserBySession } from "../services/authService.js";
import { dispatchSearch } from "../services/unifiedSearch/index.js";
import type { UnifiedSearchMode } from "../types/unifiedSearch.js";

const router = Router();

/**
 * Session gate — mirrors the pattern at psa.routes.ts:7-21. Returns
 * `false` after writing a 401 response; route handlers exit early
 * on `false`.
 */
async function requireSessionUser(req: Request, res: Response): Promise<boolean> {
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) {
    res.status(401).json({ success: false, error: "Missing x-session-id" });
    return false;
  }

  const user = await getUserBySession(sessionId);
  if (!user) {
    res.status(401).json({ success: false, error: "Invalid session" });
    return false;
  }

  return true;
}

router.post("/cards", async (req: Request, res: Response) => {
  const isAuthenticated = await requireSessionUser(req, res);
  if (!isAuthenticated) return;

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
    // The dispatcher catches per-grader failures internally and
    // surfaces them as warnings, and searchCatalog returns [] on
    // error rather than throwing. Reaching this catch indicates an
    // unexpected exception — surface as 500 with the message.
    const message = err instanceof Error ? err.message : "Unified search failed";
    res.status(500).json({ success: false, error: message });
  }
});

export default router;

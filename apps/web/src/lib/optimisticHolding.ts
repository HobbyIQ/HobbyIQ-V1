// CF-CARD-SAVE-FAST (Drew, 2026-08-31: "saving edits on a card is SLOW").
//
// The edit modal closes on a locally-merged holding instead of waiting for the
// PATCH to come back. That merge is the only thing standing between the user
// and a row that claims something the server was never asked to save, so it
// lives here as a pure function with tests rather than inline in the component.

import type { PortfolioHolding } from "@/lib/api";

/**
 * The view the user should see the instant they press Save.
 *
 * Mirrors the backend's own merge — `{...stored, ...body}` — so the optimistic
 * row cannot show a value that was never sent. Two rules keep it honest:
 *
 *   - `undefined` means "this form did not send the field", so the stored value
 *     stands. The backend spreads the request body, where an absent key is
 *     likewise a no-op. `null` is different: it is an explicit clear (a grade
 *     going back to Raw) and IS applied.
 *   - Derived fields are never synthesised. FMV, identity slugs and P&L belong
 *     to the server; the deferred reprice may move the FMV, and guessing it
 *     here would put a number on screen that no valuation path produced.
 *     Whatever the stored holding already carries is passed through untouched,
 *     and the reconcile with the server's copy replaces it.
 */
export function mergeOptimistic(
  stored: PortfolioHolding,
  patch: Record<string, unknown>,
): PortfolioHolding {
  const next = { ...(stored as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    next[key] = value;
  }
  return next as unknown as PortfolioHolding;
}

/**
 * ebayAuth.service.ts:254 -- `isTerminalTokenError`'s bare-HTTP-status
 * fallback, the LAST line of the function.
 *
 * GUARDS: `ebayPurchaseSync.job.ts` and `ebayOrderPoll.service.ts` both call
 * this to decide whether a per-user eBay token failure is TERMINAL (mark the
 * connection reconnect-required, keep going) or TRANSIENT (retry later,
 * never touch the user's connection state). The function's own doc: "eBay
 * answers a dead / revoked refresh grant with `invalid_grant`, and the OAuth
 * token endpoint returns 400 or 401 for a credential problem." This last
 * regex is the catch for a 400/401/403 that arrives WITHOUT one of the named
 * error codes (`invalid_grant`, `invalid_scope`, etc.) already matched above
 * it -- `fetchEbayToken` puts the bare HTTP status in the message.
 *
 * WHAT IT SILENTLY DID WHILE BROKEN: `\b` had degraded to a raw 0x08
 * backspace byte, so the regex required a literal backspace character
 * around the digits -- never present in a real message. This branch was
 * DEAD: a message like "eBay token exchange failed: 401 Unauthorized" with
 * no named error code fell through to `isTerminalTokenError` returning
 * `false` (transient), when the function's own doctrine says a bare
 * 400/401/403 is exactly the terminal shape it exists to catch.
 *
 * WHAT STARTS HAPPENING NOW THAT IT WORKS: a token-exchange failure message
 * carrying a bare 400, 401 or 403 -- with none of the named codes present --
 * is now correctly classified terminal (`markReconnectRequired` fires
 * instead of a silent retry).
 */
import { describe, it, expect } from "vitest";
import { isTerminalTokenError } from "../src/services/ebay/ebayAuth.service";

describe("isTerminalTokenError bare-status-code fallback (word-boundary byte repair)", () => {
  it("PINS THE REPAIR: a bare 400/401/403 with no named error code is now terminal", () => {
    expect(isTerminalTokenError("eBay token exchange failed: 401 Unauthorized")).toBe(true);
    expect(isTerminalTokenError("eBay token request failed (400): malformed request")).toBe(true);
    expect(isTerminalTokenError("HTTP 403 Forbidden from eBay token endpoint")).toBe(true);
  });

  it("does not fire on a status code embedded in a longer number", () => {
    // Word-boundary is what keeps "1400"/"4033" from matching as if they
    // contained "400"/"403" -- pinned so a widened match can't creep back in.
    expect(isTerminalTokenError("elapsed 1400ms during token refresh")).toBe(false);
    expect(isTerminalTokenError("retry-after 4033 seconds")).toBe(false);
  });

  it("still refuses a transient failure (unaffected by the byte repair)", () => {
    expect(isTerminalTokenError("eBay token request failed (500): upstream boom")).toBe(false);
    expect(isTerminalTokenError("eBay token request failed (429): slow down")).toBe(false);
    expect(isTerminalTokenError("fetch failed: ECONNRESET")).toBe(false);
  });

  it("still refuses 'not connected' even though it contains no status code (unaffected)", () => {
    expect(isTerminalTokenError("eBay account not connected for this user")).toBe(false);
  });
});

/**
 * ebayAuth.service.ts -- `isTerminalTokenError`'s bare-HTTP-status
 * fallback, the LAST line of the function.
 *
 * GUARDS: `ebayPurchaseSync.job.ts` and `ebayOrderPoll.service.ts` both call
 * this to decide whether a per-user eBay token failure is TERMINAL (mark the
 * connection reconnect-required, keep going) or TRANSIENT (retry later,
 * never touch the user's connection state). The function's own doc: "eBay
 * answers a dead / revoked refresh grant with `invalid_grant`, and the OAuth
 * token endpoint returns 400 or 401 for a credential problem."
 *
 * WHAT IT SILENTLY DID WHILE BROKEN: `\b` had degraded to a raw 0x08
 * backspace byte, so the fallback regex required a literal backspace
 * character around the digits -- never present in a real message. This
 * branch was DEAD: a message like "eBay token exchange failed: 401
 * Unauthorized" with no named error code fell through to
 * `isTerminalTokenError` returning `false` (transient).
 *
 * WHAT THIS PR DOES (split from #2315, narrowed per owner-decision request,
 * HELD): the repaired fallback is deliberately narrower than a literal
 * `\b(400|401|403)\b` revival. It fires ONLY on a bare 401 -- the one status
 * RFC 6749 §5.2 actually defines for a token-endpoint client-auth failure.
 * A bare 400 ("the request was malformed" -- can be OUR bug, not proof the
 * grant is dead) and a bare 403 (not part of the OAuth token-endpoint error
 * vocabulary at all; eBay's own developer community documents 403s from
 * this endpoint for reasons unrelated to a revoked grant, and the endpoint
 * has documented per-grant-type rate limits that can plausibly produce a
 * bare 400/403 under load) are deliberately EXCLUDED so a WAF block, a
 * transient rate-limit response, or a malformed-request bug never trips
 * `markReconnectRequired` -- which halts that user's poll cycle entirely
 * until they manually reconnect (see ebayOrderPoll.service.ts).
 */
import { describe, it, expect } from "vitest";
import { isTerminalTokenError } from "../src/services/ebay/ebayAuth.service";

describe("isTerminalTokenError bare-status-code fallback (narrowed to 401 only)", () => {
  it("PINS THE REPAIR: a bare 401 with no named error code is terminal", () => {
    expect(isTerminalTokenError("eBay token exchange failed: 401 Unauthorized")).toBe(true);
    expect(isTerminalTokenError("eBay token request failed (401): invalid credentials")).toBe(true);
  });

  it("does NOT fire on a bare 400 or 403 with no named error code (deliberately excluded)", () => {
    expect(isTerminalTokenError("eBay token request failed (400): malformed request")).toBe(false);
    expect(isTerminalTokenError("HTTP 403 Forbidden from eBay token endpoint")).toBe(false);
  });

  it("does not fire on a status code embedded in a longer number", () => {
    // Word-boundary is what keeps "1401"/"14010" from matching as if they
    // contained "401" -- pinned so a widened match can't creep back in.
    expect(isTerminalTokenError("elapsed 1401ms during token refresh")).toBe(false);
    expect(isTerminalTokenError("retry-after 14010 seconds")).toBe(false);
  });

  it("still refuses a transient failure (unaffected by the repair)", () => {
    expect(isTerminalTokenError("eBay token request failed (500): upstream boom")).toBe(false);
    expect(isTerminalTokenError("eBay token request failed (429): slow down")).toBe(false);
    expect(isTerminalTokenError("fetch failed: ECONNRESET")).toBe(false);
  });

  it("still recognizes the named OAuth error codes regardless of status code (unchanged)", () => {
    expect(isTerminalTokenError("eBay token request failed (400): invalid_grant")).toBe(true);
    expect(isTerminalTokenError("eBay token request failed (400): invalid_client")).toBe(true);
    expect(isTerminalTokenError("eBay token request failed (400): invalid_scope")).toBe(true);
    expect(isTerminalTokenError("eBay token request failed (400): unauthorized_client")).toBe(true);
  });

  it("still refuses 'not connected' even though it contains no status code (unaffected)", () => {
    expect(isTerminalTokenError("eBay account not connected for this user")).toBe(false);
  });
});

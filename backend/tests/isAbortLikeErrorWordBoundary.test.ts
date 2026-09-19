/**
 * compiq.routes.ts:181 -- `isAbortLikeError`'s message-text fallback.
 *
 * GUARDS: `/api/compiq/price` (and any other route through this helper)
 * treats a Cosmos/fetch abort or timeout as a benign, retryable condition
 * rather than a hard failure -- the caller's own doc says this exists
 * because `@azure/cosmos` sometimes rewraps an AbortError/TimeoutError
 * inside its own error, so the `.name` check above it can miss, and this
 * regex is the fallback that reads the wrapped MESSAGE text instead.
 *
 * WHAT IT SILENTLY DID WHILE BROKEN: `\b` (word boundary) had degraded to a
 * raw 0x08 backspace byte at some earlier point (a shell heredoc artifact,
 * unrelated to any recent change), so the regex required a literal
 * backspace character immediately before/after "AbortError"/"TimeoutError"
 * -- which no real error message ever contains. The message-text branch
 * was therefore DEAD: only the exact `.name === "AbortError"` /
 * `.name === "TimeoutError"` checks above it ever matched, and any error
 * whose `.name` was NOT one of those two exact strings but whose MESSAGE
 * said so (the rewrapped-by-Cosmos case this function's own doc names as
 * the reason it exists) fell through to the real-fault path instead of
 * being treated as an abort.
 *
 * WHAT STARTS HAPPENING NOW THAT IT WORKS: an error with an unrelated/generic
 * `.name` (e.g. "Error") but a message containing "AbortError", "TimeoutError"
 * or "operation was aborted" is now correctly classified as abort-like.
 */
import { describe, it, expect } from "vitest";
import { isAbortLikeError } from "../src/routes/compiq.routes";

describe("isAbortLikeError message-text fallback (word-boundary byte repair)", () => {
  it("still matches by .name alone (unaffected by the byte repair)", () => {
    expect(isAbortLikeError({ name: "AbortError", message: "aborted" })).toBe(true);
    expect(isAbortLikeError({ name: "TimeoutError", message: "timed out" })).toBe(true);
  });

  it("PINS THE REPAIR: a wrapped error with a generic name but the word in its message is now caught", () => {
    // The exact shape the caller's own doc describes: @azure/cosmos rewraps
    // the real AbortError inside its own error, so .name is no longer
    // "AbortError" but the message still says so.
    expect(isAbortLikeError({ name: "Error", message: "Request failed: AbortError: The operation was aborted" })).toBe(true);
    expect(isAbortLikeError({ name: "Error", message: "wrapped TimeoutError from upstream" })).toBe(true);
    expect(isAbortLikeError({ name: "FetchError", message: "operation was aborted" })).toBe(true);
  });

  it("does NOT match a real fault merely because it contains an unrelated substring", () => {
    // Word-boundary is what keeps this narrow -- a message that merely
    // CONTAINS the letters without being the whole word must not match.
    expect(isAbortLikeError({ name: "Error", message: "NonAbortErrorLookalike happened" })).toBe(false);
    expect(isAbortLikeError({ name: "Error", message: "bad query syntax near WHERE" })).toBe(false);
    expect(isAbortLikeError({ name: "Error", message: "403 Forbidden" })).toBe(false);
  });

  it("refuses when there is nothing to read", () => {
    expect(isAbortLikeError(null)).toBe(false);
    expect(isAbortLikeError(undefined)).toBe(false);
    expect(isAbortLikeError({})).toBe(false);
    expect(isAbortLikeError("just a string")).toBe(false);
  });
});

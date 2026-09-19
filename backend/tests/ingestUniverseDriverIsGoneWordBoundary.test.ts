/**
 * ingest-universe-driver.cjs -- the "isGone" classifier inside the
 * acquisition catch block (now extracted to its own named,
 * exported `isGoneErrorMessage`).
 *
 * GUARDS: decides whether a failed lane acquisition means "the SOURCE told
 * us this set is gone" (HTTP 404/403, DNS failure, an empty workbook, or a
 * child process exiting with code 9) vs "our own pipe broke" -- the two
 * verdicts route to different statuses (`unreachable` vs `failed`) which
 * downstream streak/backoff logic treats very differently. The surrounding
 * comment: "the sportscardchecklist zero-row refusal exits 9 and fell
 * through to `failed` -- our pipe broke -- when the host had simply not
 * served us."
 *
 * WHAT IT SILENTLY DID WHILE BROKEN: `\b` after the exit-code digit had
 * degraded to a raw 0x08 backspace byte, so the "exit 9" branch of the
 * alternation required a literal backspace character immediately after
 * the "9" -- never present in a real child-process error message. That
 * branch was DEAD: every "... exit 9: ..." message fell through to
 * `isGone = false` (unless it also happened to match the still-working
 * HTTP-40x/ENOTFOUND/workbook branches), and the lane recorded `failed`
 * (our pipe broke) instead of `unreachable` (the host said no).
 *
 * WHAT STARTS HAPPENING NOW THAT IT WORKS: a message ending "... exit 9:
 * ..." (the exact form `run()` builds) now correctly classifies as
 * `isGone = true`.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { isGoneErrorMessage } = require_("../scripts/ingest-universe-driver.cjs") as {
  isGoneErrorMessage: (msg: string) => boolean;
};

describe("isGoneErrorMessage exit-9 branch (word-boundary byte repair)", () => {
  it("PINS THE REPAIR: 'exit 9' (the form run() actually builds) is now recognized as the host being gone", () => {
    expect(isGoneErrorMessage("sportscardchecklist.cjs exit 9: zero rows returned")).toBe(true);
    expect(isGoneErrorMessage("child script exit code 9: refused")).toBe(true);
    expect(isGoneErrorMessage("beckett-downloader.cjs exited with code 9")).toBe(true);
  });

  it("does not fire on an exit code that merely starts with 9", () => {
    // Word-boundary is what keeps "90"/"99" from matching as if they were "9".
    expect(isGoneErrorMessage("script exit 90: unrelated failure")).toBe(false);
    expect(isGoneErrorMessage("script exit code 99")).toBe(false);
  });

  it("still recognizes the pre-existing HTTP/ENOTFOUND/workbook branches (unaffected)", () => {
    expect(isGoneErrorMessage("HTTP 404 Not Found")).toBe(true);
    expect(isGoneErrorMessage("HTTP 403 Forbidden")).toBe(true);
    expect(isGoneErrorMessage("getaddrinfo ENOTFOUND example.com")).toBe(true);
    expect(isGoneErrorMessage("workbook empty or unreachable")).toBe(true);
  });

  it("still refuses an unrelated failure (unaffected)", () => {
    expect(isGoneErrorMessage("TypeError: cannot read property of undefined")).toBe(false);
    expect(isGoneErrorMessage("ECONNRESET")).toBe(false);
  });
});

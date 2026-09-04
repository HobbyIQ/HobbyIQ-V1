/**
 * A dead eBay grant is a PER-USER CONDITION, not a job failure.
 *
 * Run 33848620910 failed the whole weekly purchase sync because two of nine
 * users had grants eBay refuses:
 *
 *   admin-testing-hobbyiq                  invalid_scope
 *   user-8aa46493-ddf0-4c45-8c58-ff6b68af02b0  invalid_grant
 *
 * Neither lost a purchase -- `getAccessToken` throws before any fetch, so
 * there is nothing to write and nothing to lose. Failing the run on them
 * hides the seven users who synced, and the exit code says "data problem"
 * when the truth is "two users must reconnect eBay".
 *
 * These pin the classification (which errors are terminal, which are
 * transient) and the runner's exit-code contract.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isTerminalTokenError } from "../src/services/ebay/ebayAuth.service.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = fs.readFileSync(path.join(backend, "scripts", "run-ebay-purchase-sync.cjs"), "utf8");
const job = fs.readFileSync(path.join(backend, "src", "jobs", "ebayPurchaseSync.job.ts"), "utf8");

/** The two messages the incident actually produced, verbatim from the log. */
const INVALID_SCOPE =
  'eBay token request failed (400): {"error":"invalid_scope","error_description":"The requested scope is invalid, unknown, malformed, or exceeds the scope granted to the client"}';
const INVALID_GRANT =
  'eBay token request failed (400): {"error":"invalid_grant","error_description":"the provided authorization refresh token is invalid or was issued to another client"}';

describe("both incident errors classify as terminal token failures", () => {
  it("invalid_scope is terminal -- the grant predates the scope set the client now asks for", () => {
    expect(isTerminalTokenError(INVALID_SCOPE)).toBe(true);
  });

  it("invalid_grant is terminal -- the refresh token is revoked or expired", () => {
    expect(isTerminalTokenError(INVALID_GRANT)).toBe(true);
  });
});

describe("MUTATION: transient failures must NOT be treated as reconnect-required", () => {
  // Marking a user reconnect-required over a blip logs them out of their own
  // sync. If the classifier is ever widened to "any error", these fail.
  it("a 500 is not terminal", () => {
    expect(isTerminalTokenError("eBay token request failed (500): upstream boom")).toBe(false);
  });

  it("a 429 is not terminal", () => {
    expect(isTerminalTokenError("eBay token request failed (429): slow down")).toBe(false);
  });

  it("a socket error is not terminal", () => {
    expect(isTerminalTokenError("fetch failed: ECONNRESET")).toBe(false);
  });

  it("'not connected' is not a reconnect-required mark", () => {
    expect(isTerminalTokenError("eBay account not connected for this user")).toBe(false);
  });
});

describe("the job separates a dead grant from a data failure", () => {
  it("classifies each per-user throw with isTerminalTokenError", () => {
    expect(job).toContain("isTerminalTokenError(msg)");
  });

  it("marks the connection reconnect-required so the account page can say so", () => {
    expect(job).toContain("markReconnectRequired(userId");
  });

  it("keeps reconnect users and data failures in SEPARATE lists", () => {
    expect(job).toContain("reconnectRequired.push");
    expect(job).toContain("dataFailures.push");
  });

  it("still reports a whole-run fatal as a DATA failure, not a reconnect", () => {
    // The outer catch (listConnectedUserIds threw, etc.) means intended work
    // never happened -- that IS data loss and must fail the job.
    expect(job).toContain('dataFailures.push({ userId: "(job)"');
    // ...and it must not be classified as a reconnect condition.
    expect(job).not.toMatch(/fatal:[\s\S]{0,120}reconnectRequired\.push/);
  });
});

describe("the runner's exit code reflects DATA failures only", () => {
  it("never charges the USER-counted `s.errors` into the purchase equation", () => {
    // This is the exact defect: `failed: Number(s.errors ?? 0)`.
    expect(runner).not.toMatch(/failed:\s*Number\(s\.errors/);
    expect(runner).toContain("failed: 0,");
  });

  it("exits 1 on data failures", () => {
    expect(runner).toMatch(/if \(dataFailures\.length > 0\) \{[\s\S]{0,200}process\.exit\(1\)/);
  });

  it("does NOT exit on token failures alone", () => {
    // The old gate. If it comes back, a single dead grant fails the run again.
    expect(runner).not.toMatch(/if \(Number\(s\.errors \?\? 0\) > 0\)/);
  });

  it("names every user that must reconnect, so the condition is reported not buried", () => {
    expect(runner).toContain("must reconnect eBay");
    expect(runner).toMatch(/for \(const r of reconnect\)/);
  });
});

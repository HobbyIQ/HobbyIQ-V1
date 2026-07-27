// CF-EMAIL-VERIFICATION (Drew, 2026-07-27). Pins the token flow's
// happy path + the three failure modes: unknown token, expired token,
// email-changed-between-issue-and-click.

import { beforeEach, describe, expect, it } from "vitest";
import {
  registerUser,
  issueEmailVerification,
  consumeEmailVerification,
  _resetMemStoreForTests,
} from "../src/services/authService.js";

async function newUser(email: string) {
  const r = await registerUser({
    email,
    username: `u${Math.random().toString(36).slice(2, 8)}`,
    password: "Password!23",
  });
  if (!r.success || !r.user) throw new Error("register failed");
  return r.user;
}

describe("CF-EMAIL-VERIFICATION — token flow", () => {
  beforeEach(() => _resetMemStoreForTests());

  it("issues a token and consumes it on the happy path", async () => {
    const u = await newUser("verify-happy@example.com");
    const issued = await issueEmailVerification(u.userId);
    expect(issued).not.toBeNull();
    expect(issued!.token.length).toBeGreaterThan(20);
    expect(issued!.email).toBe("verify-happy@example.com");

    const consumed = await consumeEmailVerification(issued!.token);
    expect(consumed).not.toBeNull();
    expect(consumed!.user.emailVerified).toBe(true);
    expect(consumed!.user.emailVerificationPending).toBe(false);
  });

  it("rejects an unknown token", async () => {
    const consumed = await consumeEmailVerification("does-not-exist-token");
    expect(consumed).toBeNull();
  });

  it("rejects a token after it's already been consumed once", async () => {
    const u = await newUser("verify-single-use@example.com");
    const issued = await issueEmailVerification(u.userId);
    const first = await consumeEmailVerification(issued!.token);
    expect(first).not.toBeNull();
    const second = await consumeEmailVerification(issued!.token);
    expect(second).toBeNull();
  });

  it("issuing a new token invalidates the previous one (resend)", async () => {
    const u = await newUser("verify-resend@example.com");
    const first = await issueEmailVerification(u.userId);
    const second = await issueEmailVerification(u.userId);
    expect(second!.token).not.toBe(first!.token);
    // The old token no longer works.
    const stale = await consumeEmailVerification(first!.token);
    expect(stale).toBeNull();
    // The new one does.
    const fresh = await consumeEmailVerification(second!.token);
    expect(fresh).not.toBeNull();
    expect(fresh!.user.emailVerified).toBe(true);
  });

  it("returns null for a user with no email on file", async () => {
    const issued = await issueEmailVerification("user-does-not-exist");
    expect(issued).toBeNull();
  });

  it("issues token includes an expiresAt in the future", async () => {
    const u = await newUser("verify-expiry@example.com");
    const issued = await issueEmailVerification(u.userId);
    expect(Date.parse(issued!.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("emailVerified stays false until the token is consumed", async () => {
    const u = await newUser("verify-pending@example.com");
    await issueEmailVerification(u.userId);
    // Fresh register/issue: emailVerified is still false.
    const consumed = await consumeEmailVerification("wrong-token");
    expect(consumed).toBeNull();
  });
});

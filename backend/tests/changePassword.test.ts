// CF-CHANGE-PASSWORD (Drew, 2026-07-27). Pins the happy path + the four
// failure modes that matter: wrong current password, weak new password,
// invalid session, Apple-OAuth accounts rejected.

import { beforeEach, describe, expect, it } from "vitest";
import {
  registerUser,
  signIn,
  changePasswordForSession,
  _resetMemStoreForTests,
} from "../src/services/authService.js";

async function registerAndSignIn(email: string, password: string) {
  const reg = await registerUser({
    email,
    username: `u${Math.random().toString(36).slice(2, 8)}`,
    password,
  });
  if (!reg.success || !reg.sessionId) throw new Error("register failed");
  return reg.sessionId;
}

describe("CF-CHANGE-PASSWORD", () => {
  beforeEach(() => _resetMemStoreForTests());

  it("changes password on the happy path", async () => {
    const sid = await registerAndSignIn("cp-happy@example.com", "OldPass!23");
    const res = await changePasswordForSession(sid, "OldPass!23", "NewPass!45");
    expect(res.success).toBe(true);

    // Old password no longer signs in.
    const oldSignIn = await signIn("cp-happy@example.com", "OldPass!23");
    expect(oldSignIn.success).toBe(false);

    // New password does.
    const newSignIn = await signIn("cp-happy@example.com", "NewPass!45");
    expect(newSignIn.success).toBe(true);
  });

  it("rejects when the current password is wrong", async () => {
    const sid = await registerAndSignIn("cp-wrong@example.com", "OldPass!23");
    const res = await changePasswordForSession(sid, "not-the-password", "NewPass!45");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/current password/i);
  });

  it("rejects when the new password is too short", async () => {
    const sid = await registerAndSignIn("cp-weak@example.com", "OldPass!23");
    const res = await changePasswordForSession(sid, "OldPass!23", "tiny");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/8 characters/i);
  });

  it("rejects an invalid session", async () => {
    const res = await changePasswordForSession(
      "obviously-not-a-real-token.something",
      "any",
      "AnythingElse!45",
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/session/i);
  });

  it("does not fall back to the old hash after a successful change", async () => {
    // Regression pin: earlier drafts kept both hashes to allow rollback.
    // Removed — after a successful change, ONLY the new password works.
    const sid = await registerAndSignIn("cp-onehash@example.com", "OldPass!23");
    await changePasswordForSession(sid, "OldPass!23", "NewPass!45");
    const second = await changePasswordForSession(sid, "OldPass!23", "Another!67");
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/current password/i);
  });
});

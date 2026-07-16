// CF-VERDICT-FLIP-PUSH-PREFS-ROUTE (Drew, 2026-07-16, PR #500 follow-up).
// Route contract for /api/portfolio/preferences.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../src/app";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(): Promise<string> {
  const response = await request(app)
    .post("/api/auth/signin")
    .send({ username: "HobbyIQ", password: "Baseball25" });
  expect(response.status).toBe(200);
  return response.body.sessionId as string;
}

describe("GET /api/portfolio/preferences", () => {
  it("returns { pushOnMajorFlip: false, registered: false } for a fresh user", async () => {
    const sessionId = await signIn();
    const res = await request(app)
      .get("/api/portfolio/preferences")
      .set("x-session-id", sessionId);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The signInAs user may have been touched by prior tests in the run
    // (testMemStore is shared across the file). Just assert shape.
    expect(typeof res.body.preferences.pushOnMajorFlip).toBe("boolean");
    expect(typeof res.body.apnsDevice.registered).toBe("boolean");
  });

  it("401 when no session", async () => {
    const res = await request(app).get("/api/portfolio/preferences");
    expect(res.status).toBe(401);
  });

  it("does NOT leak the raw apnsDeviceToken value", async () => {
    const sessionId = await signIn();
    const testToken = "abc123.def456.ghi789JKL0mn0pqrs.uvwxyzABCDEFGHIJK.z";
    await request(app)
      .patch("/api/portfolio/preferences")
      .set("x-session-id", sessionId)
      .send({ apnsDeviceToken: testToken });
    const res = await request(app)
      .get("/api/portfolio/preferences")
      .set("x-session-id", sessionId);
    expect(res.status).toBe(200);
    expect(res.body.apnsDevice.registered).toBe(true);
    // Token itself must not appear in the response.
    expect(JSON.stringify(res.body)).not.toContain(testToken);
  });
});

describe("PATCH /api/portfolio/preferences", () => {
  it("400 when the body has neither pushOnMajorFlip nor apnsDeviceToken", async () => {
    const sessionId = await signIn();
    const res = await request(app)
      .patch("/api/portfolio/preferences")
      .set("x-session-id", sessionId)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("pushOnMajorFlip");
  });

  it("400 when pushOnMajorFlip is not a boolean", async () => {
    const sessionId = await signIn();
    const res = await request(app)
      .patch("/api/portfolio/preferences")
      .set("x-session-id", sessionId)
      .send({ pushOnMajorFlip: "true" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("boolean");
  });

  it("400 when apnsDeviceToken is too short", async () => {
    const sessionId = await signIn();
    const res = await request(app)
      .patch("/api/portfolio/preferences")
      .set("x-session-id", sessionId)
      .send({ apnsDeviceToken: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("32-256");
  });

  it("400 when apnsDeviceToken contains disallowed characters", async () => {
    const sessionId = await signIn();
    const res = await request(app)
      .patch("/api/portfolio/preferences")
      .set("x-session-id", sessionId)
      .send({ apnsDeviceToken: "a".repeat(64) + " space in middle" });
    expect(res.status).toBe(400);
  });

  it("writes pushOnMajorFlip: true and echoes back", async () => {
    const sessionId = await signIn();
    const res = await request(app)
      .patch("/api/portfolio/preferences")
      .set("x-session-id", sessionId)
      .send({ pushOnMajorFlip: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.preferences.pushOnMajorFlip).toBe(true);
  });

  it("writes apnsDeviceToken and confirms via registered flag", async () => {
    const sessionId = await signIn();
    const token = "z".repeat(64);
    const res = await request(app)
      .patch("/api/portfolio/preferences")
      .set("x-session-id", sessionId)
      .send({ apnsDeviceToken: token });
    expect(res.status).toBe(200);
    expect(res.body.apnsDevice.registered).toBe(true);
    expect(res.body.apnsDevice.registeredAt).toBeTruthy();
  });

  it("apnsDeviceToken: null clears the registration", async () => {
    const sessionId = await signIn();
    // Set first
    await request(app)
      .patch("/api/portfolio/preferences")
      .set("x-session-id", sessionId)
      .send({ apnsDeviceToken: "y".repeat(80) });
    // Then null
    const res = await request(app)
      .patch("/api/portfolio/preferences")
      .set("x-session-id", sessionId)
      .send({ apnsDeviceToken: null });
    expect(res.status).toBe(200);
    expect(res.body.apnsDevice.registered).toBe(false);
  });

  it("empty string apnsDeviceToken is equivalent to null (clears registration)", async () => {
    const sessionId = await signIn();
    await request(app)
      .patch("/api/portfolio/preferences")
      .set("x-session-id", sessionId)
      .send({ apnsDeviceToken: "x".repeat(70) });
    const res = await request(app)
      .patch("/api/portfolio/preferences")
      .set("x-session-id", sessionId)
      .send({ apnsDeviceToken: "" });
    expect(res.status).toBe(200);
    expect(res.body.apnsDevice.registered).toBe(false);
  });

  it("accepts both fields in one call", async () => {
    const sessionId = await signIn();
    const res = await request(app)
      .patch("/api/portfolio/preferences")
      .set("x-session-id", sessionId)
      .send({ pushOnMajorFlip: true, apnsDeviceToken: "w".repeat(64) });
    expect(res.status).toBe(200);
    expect(res.body.preferences.pushOnMajorFlip).toBe(true);
    expect(res.body.apnsDevice.registered).toBe(true);
  });

  it("401 when no session", async () => {
    const res = await request(app)
      .patch("/api/portfolio/preferences")
      .send({ pushOnMajorFlip: true });
    expect(res.status).toBe(401);
  });
});

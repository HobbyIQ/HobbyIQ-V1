/**
 * D.5 — eBay webhook tests.
 *
 *   GET  /api/ebay/webhook  — challenge handshake (SHA-256 hex digest)
 *   POST /api/ebay/webhook  — notification dispatcher
 *     - MARKETPLACE_ACCOUNT_DELETION → deleteTokenRecord by ebay-side identifier
 *     - any other topic (ITEM_SOLD, etc.) → 200 stub, no side effects
 *
 * Always responds 200 on POST (eBay treats non-2xx as a delivery failure).
 *
 * The token-store dependency is mocked so we don't touch Cosmos or the
 * file-backed cache.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "crypto";

const findUserIdByEbayUserId = vi.fn<(s: string) => Promise<string | null>>();
const deleteTokenRecord = vi.fn<(s: string) => Promise<void>>();

vi.mock("../src/services/ebay/ebayTokenStore.service.js", () => ({
  findUserIdByEbayUserId: (s: string) => findUserIdByEbayUserId(s),
  deleteTokenRecord: (s: string) => deleteTokenRecord(s),
}));

import ebayWebhookRoutes, {
  computeChallengeResponse,
} from "../src/routes/ebayWebhook.routes.js";

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/ebay/webhook", ebayWebhookRoutes);
  return app;
}

beforeEach(() => {
  process.env.EBAY_WEBHOOK_VERIFICATION_TOKEN = "test-token-abc123";
  process.env.EBAY_WEBHOOK_ENDPOINT = "https://example.com/api/ebay/webhook";
  findUserIdByEbayUserId.mockReset();
  deleteTokenRecord.mockReset();
});

afterEach(() => {
  delete process.env.EBAY_WEBHOOK_VERIFICATION_TOKEN;
  delete process.env.EBAY_WEBHOOK_ENDPOINT;
});

// ---------------------------------------------------------------------------
// computeChallengeResponse — pure unit
// ---------------------------------------------------------------------------

describe("computeChallengeResponse", () => {
  it("hashes challengeCode + token + endpoint with SHA-256, hex-encoded", () => {
    const challenge = "abc-123";
    const token = "tok";
    const endpoint = "https://example.com/api/ebay/webhook";
    const expected = crypto
      .createHash("sha256")
      .update(challenge)
      .update(token)
      .update(endpoint)
      .digest("hex");
    expect(computeChallengeResponse(challenge, token, endpoint)).toBe(expected);
  });

  it("produces different digests when any input changes", () => {
    const a = computeChallengeResponse("c", "t", "e");
    const b = computeChallengeResponse("c", "t", "e2");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// GET /api/ebay/webhook — challenge handshake
// ---------------------------------------------------------------------------

describe("GET /api/ebay/webhook", () => {
  it("returns 200 + challengeResponse when challenge_code + token are valid", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/api/ebay/webhook")
      .query({ challenge_code: "challenge-xyz" });

    expect(res.status).toBe(200);
    const expected = computeChallengeResponse(
      "challenge-xyz",
      "test-token-abc123",
      "https://example.com/api/ebay/webhook",
    );
    expect(res.body).toEqual({ challengeResponse: expected });
  });

  it("returns 400 when challenge_code is missing", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/ebay/webhook");
    expect(res.status).toBe(400);
  });

  it("returns 500 when verification token is not configured", async () => {
    delete process.env.EBAY_WEBHOOK_VERIFICATION_TOKEN;
    const app = buildApp();
    const res = await request(app)
      .get("/api/ebay/webhook")
      .query({ challenge_code: "challenge-xyz" });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// POST /api/ebay/webhook — notification dispatcher
// ---------------------------------------------------------------------------

describe("POST /api/ebay/webhook — MARKETPLACE_ACCOUNT_DELETION", () => {
  it("deletes the token record when an ebay username matches a stored user", async () => {
    findUserIdByEbayUserId.mockImplementation(async (id) =>
      id === "ebay-user-1" ? "hobbyiq-user-42" : null,
    );
    deleteTokenRecord.mockResolvedValue();

    const app = buildApp();
    const res = await request(app)
      .post("/api/ebay/webhook")
      .send({
        metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
        notification: {
          notificationId: "n-1",
          data: { username: "ebay-user-1", userId: "ENC-123" },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(findUserIdByEbayUserId).toHaveBeenCalledWith("ebay-user-1");
    expect(deleteTokenRecord).toHaveBeenCalledWith("hobbyiq-user-42");
  });

  it("falls back to encrypted userId when username does not match", async () => {
    findUserIdByEbayUserId.mockImplementation(async (id) =>
      id === "ENC-456" ? "hobbyiq-user-9" : null,
    );
    deleteTokenRecord.mockResolvedValue();

    const app = buildApp();
    const res = await request(app)
      .post("/api/ebay/webhook")
      .send({
        metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
        notification: {
          notificationId: "n-2",
          data: { username: "stranger", userId: "ENC-456" },
        },
      });

    expect(res.status).toBe(200);
    expect(deleteTokenRecord).toHaveBeenCalledWith("hobbyiq-user-9");
  });

  it("still returns 200 when no token record matches (already deleted / never connected)", async () => {
    findUserIdByEbayUserId.mockResolvedValue(null);
    deleteTokenRecord.mockResolvedValue();

    const app = buildApp();
    const res = await request(app)
      .post("/api/ebay/webhook")
      .send({
        metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
        notification: {
          notificationId: "n-3",
          data: { username: "ghost-user", userId: "ENC-GHOST" },
        },
      });

    expect(res.status).toBe(200);
    expect(deleteTokenRecord).not.toHaveBeenCalled();
  });

  it("still returns 200 even if deleteTokenRecord throws", async () => {
    findUserIdByEbayUserId.mockResolvedValue("hobbyiq-user-1");
    deleteTokenRecord.mockRejectedValue(new Error("cosmos blew up"));

    const app = buildApp();
    const res = await request(app)
      .post("/api/ebay/webhook")
      .send({
        metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
        notification: { notificationId: "n-4", data: { username: "x" } },
      });

    expect(res.status).toBe(200);
  });
});

describe("POST /api/ebay/webhook — other topics", () => {
  it("returns 200 and takes no action on ITEM_SOLD (D.5 stub)", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/ebay/webhook")
      .send({
        metadata: { topic: "ITEM_SOLD" },
        notification: { notificationId: "n-5", data: {} },
      });

    expect(res.status).toBe(200);
    expect(findUserIdByEbayUserId).not.toHaveBeenCalled();
    expect(deleteTokenRecord).not.toHaveBeenCalled();
  });

  it("returns 200 on unknown / missing topics", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/ebay/webhook")
      .send({});
    expect(res.status).toBe(200);
  });
});

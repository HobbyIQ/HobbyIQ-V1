// CF-D1 (2026-06-20) — case-insensitive holdingId lookup.
//
// VERIFY (Cosmos audit, captured pre-build): 14/14 existing portfolio
// holding keys are uniformly lowercase. So the fix is lookup-side
// case-fold only — no write-time backfill, no migration.
//
// Tests assert the three invariants Drew specified:
//   1. Case-mismatched id resolves to the stored holding (the bite case).
//   2. Exact-case match still works (existing data tolerance).
//   3. Missing id still returns null/404 (no false matches).
//
// Exercised through linkEbayListing (the canonical motivating case from
// the CF-D recon) plus a deleteHolding + sellHolding spot check to
// confirm the helper is wired across multiple call sites.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../src/app";
import {
  linkEbayListing,
} from "../src/services/portfolioiq/portfolioStore.service.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(): Promise<{ sessionId: string; userId: string }> {
  const response = await request(app)
    .post("/api/auth/signin")
    .send({ username: "HobbyIQ", password: "Baseball25" });
  expect(response.status).toBe(200);
  return {
    sessionId: response.body.sessionId as string,
    userId: response.body.user?.userId as string,
  };
}

async function addHolding(sessionId: string, id: string): Promise<void> {
  const res = await request(app)
    .post("/api/portfolio/holdings")
    .set("x-session-id", sessionId)
    .send({
      id,
      playerName: "Paul Skenes",
      cardYear: 2024,
      product: "Bowman Chrome",
      cardTitle: "2024 Bowman Chrome Auto",
      quantity: 1,
      purchasePrice: 100,
      totalCostBasis: 100,
    });
  expect(res.status).toBe(201);
}

describe("CF-D1 — holdingId case-insensitive lookup", () => {
  describe("linkEbayListing", () => {
    it("(1) case-mismatched id resolves to the stored holding", async () => {
      const { sessionId, userId } = await signIn();
      const storedId = "abc12345-stored-lowercase-uuid";
      await addHolding(sessionId, storedId);

      // Caller sends uppercase variant of the same id.
      const result = await linkEbayListing(userId, storedId.toUpperCase(), {
        offerId: "OFFER-1",
        listingId: "LISTING-1",
      });

      expect(result).not.toBeNull();
      expect(result!.id).toBe(storedId);  // canonical key preserved
      expect(result!.ebayOfferId).toBe("OFFER-1");
      expect(result!.ebayListingId).toBe("LISTING-1");
    });

    it("(2) exact-case match still works", async () => {
      const { sessionId, userId } = await signIn();
      const storedId = "exact-case-uuid-12345";
      await addHolding(sessionId, storedId);

      const result = await linkEbayListing(userId, storedId, {
        offerId: "OFFER-2",
        listingId: "LISTING-2",
      });

      expect(result).not.toBeNull();
      expect(result!.id).toBe(storedId);
    });

    it("(3) missing id returns null (no false case-fold match)", async () => {
      const { userId } = await signIn();
      // No holding added; lookup must still cleanly return null.
      const result = await linkEbayListing(userId, "does-not-exist-anywhere", {
        offerId: "OFFER-3",
        listingId: "LISTING-3",
      });

      expect(result).toBeNull();
    });

    it("(4) mixed-case lookup doesn't create a duplicate slot", async () => {
      const { sessionId, userId } = await signIn();
      const storedId = "case-fold-no-dupe-uuid";
      await addHolding(sessionId, storedId);

      // First link via uppercase variant.
      await linkEbayListing(userId, storedId.toUpperCase(), {
        offerId: "OFFER-4",
        listingId: "LISTING-4",
      });

      // Verify there's still only ONE holding for that user with that base id.
      const portfolioRes = await request(app)
        .get("/api/portfolio")
        .set("x-session-id", sessionId);
      expect(portfolioRes.status).toBe(200);
      const items = portfolioRes.body.items as Array<{ id: string }>;
      const matches = items.filter((h) => h.id.toLowerCase() === storedId.toLowerCase());
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe(storedId);
    });
  });

  describe("deleteHolding (route)", () => {
    it("case-mismatched id deletes the right holding", async () => {
      const { sessionId } = await signIn();
      const storedId = "delete-me-by-uppercase-lookup";
      await addHolding(sessionId, storedId);

      const res = await request(app)
        .delete(`/api/portfolio/holdings/${encodeURIComponent(storedId.toUpperCase())}`)
        .set("x-session-id", sessionId);

      expect(res.status).toBe(200);

      // Subsequent GET should return 404.
      const checkRes = await request(app)
        .get(`/api/portfolio/holdings/${encodeURIComponent(storedId)}`)
        .set("x-session-id", sessionId);
      expect(checkRes.status).toBe(404);
    });

    it("missing id still 404s", async () => {
      const { sessionId } = await signIn();
      const res = await request(app)
        .delete("/api/portfolio/holdings/nonexistent-uuid-from-test")
        .set("x-session-id", sessionId);
      expect(res.status).toBe(404);
    });
  });

  describe("getHoldingById (route)", () => {
    it("case-mismatched id resolves; returned shape carries canonical id", async () => {
      const { sessionId } = await signIn();
      const storedId = "read-via-uppercase-uuid";
      await addHolding(sessionId, storedId);

      const res = await request(app)
        .get(`/api/portfolio/holdings/${encodeURIComponent(storedId.toUpperCase())}`)
        .set("x-session-id", sessionId);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(storedId);  // canonical id surfaces on the wire
    });
  });
});

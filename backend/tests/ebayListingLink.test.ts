import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../src/app";
import {
  linkEbayListing,
  unlinkEbayListingByOfferId,
  findHoldingByEbayOfferId,
  findHoldingByEbayOfferIdAcrossUsers,
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

describe("eBay listing link helpers (PR D.6)", () => {
  it("linkEbayListing persists offerId/listingId/publishedAt on the holding", async () => {
    const { sessionId, userId } = await signIn();

    const holdingId = "ebay-link-test-holding-1";
    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", sessionId)
      .send({
        id: holdingId,
        playerName: "Paul Skenes",
        cardTitle: "2024 Bowman Chrome Auto",
        quantity: 1,
        purchasePrice: 100,
        totalCostBasis: 100,
      });
    expect(add.status).toBe(201);

    const linked = await linkEbayListing(userId, holdingId, {
      offerId: "OFFER-123",
      listingId: "LISTING-456",
      publishedAt: "2026-05-21T12:00:00.000Z",
    });
    expect(linked).not.toBeNull();
    expect(linked?.ebayOfferId).toBe("OFFER-123");
    expect(linked?.ebayListingId).toBe("LISTING-456");
    expect(linked?.ebayListingPublishedAt).toBe("2026-05-21T12:00:00.000Z");

    const found = await findHoldingByEbayOfferId(userId, "OFFER-123");
    expect(found?.id).toBe(holdingId);
  });

  it("unlinkEbayListingByOfferId clears all three fields", async () => {
    const { sessionId, userId } = await signIn();

    const holdingId = "ebay-link-test-holding-2";
    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", sessionId)
      .send({
        id: holdingId,
        playerName: "Jackson Holliday",
        cardTitle: "2024 Topps Chrome RC",
        quantity: 1,
        purchasePrice: 50,
        totalCostBasis: 50,
      });

    await linkEbayListing(userId, holdingId, {
      offerId: "OFFER-UNLINK-1",
      listingId: "LISTING-UNLINK-1",
      publishedAt: "2026-05-21T12:00:00.000Z",
    });

    const cleared = await unlinkEbayListingByOfferId(userId, "OFFER-UNLINK-1");
    expect(cleared).not.toBeNull();
    expect(cleared?.ebayOfferId).toBeNull();
    expect(cleared?.ebayListingId).toBeNull();
    expect(cleared?.ebayListingPublishedAt).toBeNull();

    const stillFound = await findHoldingByEbayOfferId(userId, "OFFER-UNLINK-1");
    expect(stillFound).toBeNull();
  });

  it("linkEbayListing returns null for non-existent holding", async () => {
    const { userId } = await signIn();
    const result = await linkEbayListing(userId, "does-not-exist", {
      offerId: "OFFER-X",
      listingId: "LISTING-X",
    });
    expect(result).toBeNull();
  });

  it("unlinkEbayListingByOfferId returns null when no holding matches", async () => {
    const { userId } = await signIn();
    const result = await unlinkEbayListingByOfferId(userId, "OFFER-NEVER-LINKED");
    expect(result).toBeNull();
  });

  it("relinking overwrites previous values (idempotent)", async () => {
    const { sessionId, userId } = await signIn();

    const holdingId = "ebay-link-test-holding-3";
    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", sessionId)
      .send({
        id: holdingId,
        playerName: "Wyatt Langford",
        cardTitle: "2024 Bowman Chrome Auto",
        quantity: 1,
        purchasePrice: 30,
        totalCostBasis: 30,
      });

    await linkEbayListing(userId, holdingId, {
      offerId: "OFFER-FIRST",
      listingId: "LISTING-FIRST",
    });
    const second = await linkEbayListing(userId, holdingId, {
      offerId: "OFFER-SECOND",
      listingId: "LISTING-SECOND",
    });

    expect(second?.ebayOfferId).toBe("OFFER-SECOND");
    expect(second?.ebayListingId).toBe("LISTING-SECOND");
    const oldFound = await findHoldingByEbayOfferId(userId, "OFFER-FIRST");
    expect(oldFound).toBeNull();
  });

  it("findHoldingByEbayOfferIdAcrossUsers locates a holding regardless of user", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = "ebay-cross-user-1";
    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", sessionId)
      .send({
        id: holdingId,
        playerName: "Jasson Dominguez",
        cardTitle: "2024 Bowman Chrome",
        quantity: 1,
        purchasePrice: 40,
        totalCostBasis: 40,
      });

    await linkEbayListing(userId, holdingId, {
      offerId: "OFFER-CROSS-1",
      listingId: "LISTING-CROSS-1",
    });

    const match = await findHoldingByEbayOfferIdAcrossUsers("OFFER-CROSS-1");
    expect(match).not.toBeNull();
    expect(match?.userId).toBe(userId);
    expect(match?.holdingId).toBe(holdingId);
    expect(match?.holding.ebayOfferId).toBe("OFFER-CROSS-1");
  });

  it("findHoldingByEbayOfferIdAcrossUsers returns null for unknown offerId and rejects empty input", async () => {
    expect(await findHoldingByEbayOfferIdAcrossUsers("OFFER-NEVER-EXISTED")).toBeNull();
    expect(await findHoldingByEbayOfferIdAcrossUsers("")).toBeNull();
  });

  it("findHoldingByEbayOfferIdAcrossUsers logs CRITICAL and picks first deterministically when invariant violated", async () => {
    const { sessionId, userId } = await signIn();
    // Create two holdings under the SAME user that both claim the same offerId.
    // This simulates the data-corruption case (in real life eBay would never
    // mint two offerIds, but a buggy publish path could end up here).
    const a = "ebay-dup-offer-A";
    const b = "ebay-dup-offer-B";
    for (const id of [a, b]) {
      await request(app)
        .post("/api/portfolio/holdings")
        .set("x-session-id", sessionId)
        .send({
          id,
          playerName: "Bobby Witt Jr",
          cardTitle: "2020 Bowman Chrome",
          quantity: 1,
          purchasePrice: 50,
          totalCostBasis: 50,
        });
    }
    await linkEbayListing(userId, a, { offerId: "OFFER-DUP", listingId: "LIST-A" });
    await linkEbayListing(userId, b, { offerId: "OFFER-DUP", listingId: "LIST-B" });

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const match = await findHoldingByEbayOfferIdAcrossUsers("OFFER-DUP");
      expect(match).not.toBeNull();
      // Deterministic: alphabetical by holdingId when userId ties.
      expect(match?.holdingId).toBe(a);
    } finally {
      console.error = origError;
    }

    expect(errors.some((e) => e.includes("CRITICAL") && e.includes("OFFER-DUP"))).toBe(true);
    expect(errors.some((e) => e.includes("INVARIANT VIOLATED"))).toBe(true);
  });
});

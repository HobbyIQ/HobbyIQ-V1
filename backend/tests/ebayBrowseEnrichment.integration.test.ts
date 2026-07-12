// CF-EBAY-BROWSE-ENRICHMENT (2026-07-12).
//
// Runtime-path proof: when the auto-holding batch runs against a fresh
// eBay purchase carrying an ebayItemId, the Browse prefetch fires,
// applyBrowseEnrichment merges the response, and the resulting holding
// has grader/team/photos/aspects from the Browse mock — not just title
// parse.
//
// Distinct from ebayBrowseEnrichment.test.ts (unit-only on the merger)
// and ebayAutoHolding.integration.test.ts (title-parse path with fetch
// blocked). Here fetch IS mocked and returns a canned Browse payload.

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";
import { writeTokenRecord } from "../src/services/ebay/ebayTokenStore.service.js";

const BROWSE_PAYLOAD = {
  itemId: "v1|407015594876|0",
  title: "2020 Panini Prizm Mookie Betts #275 PSA 10",
  shortDescription: "PSA 10 GEM MINT — from smoke-free collection",
  price: { value: 200, currency: "USD" },
  condition: "Graded",
  conditionDescriptors: [
    { name: "Professional Grader", values: [{ content: "Professional Sports Authenticator (PSA)" }] },
    { name: "Grade", values: [{ content: "10" }] },
  ],
  localizedAspects: [
    { name: "Player", value: "Mookie Betts" },
    { name: "Team", value: "Los Angeles Dodgers" },
    { name: "Sport", value: "Baseball" },
    { name: "Season", value: "2020" },
    { name: "Set", value: "Panini Prizm" },
    { name: "Manufacturer", value: "Panini" },
    { name: "Card Number", value: "275" },
    { name: "Autographed", value: "No" },
  ],
  image: { imageUrl: "https://i.ebayimg.com/mock/primary.jpg" },
  additionalImages: [
    { imageUrl: "https://i.ebayimg.com/mock/back.jpg" },
  ],
  categoryPath: "Sports Mem, Cards & Fan Shop|Sports Trading Cards|Baseball Cards",
  seller: { username: "mockseller", feedbackScore: 5432 },
  itemCreationDate: "2026-07-01T00:00:00Z",
  buyingOptions: ["FIXED_PRICE"],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    // eBay OAuth token endpoint — Browse client calls getAccessToken
    // which hits the identity/oauth2 endpoint if a refresh is needed.
    // Return a static valid response so we skip real auth.
    if (typeof url === "string" && url.includes("identity/v1/oauth2/token")) {
      return new Response(
        JSON.stringify({
          access_token: "mock-access",
          refresh_token: "mock-refresh",
          expires_in: 3600,
          refresh_token_expires_in: 47000000,
          scope: "https://api.ebay.com/oauth/api_scope",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Browse API by legacy id
    if (typeof url === "string" && url.includes("/buy/browse/v1/item/")) {
      return new Response(JSON.stringify(BROWSE_PAYLOAD), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Any other call: reject explicitly so test failure is loud
    return new Response("unexpected fetch: " + url, { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(): Promise<string> {
  const r = await request(app).post("/api/auth/signin").send({ username: "HobbyIQ", password: "Baseball25" });
  expect(r.status).toBe(200);
  return r.body.sessionId as string;
}

async function seedEbayToken(userId: string) {
  // Runtime path calls getAccessToken which reads from the token store.
  // Seed a live-window record so Browse client's OAuth path doesn't need
  // to refresh via HTTP (accessTokenExpiresAt in the future).
  await writeTokenRecord({
    userId,
    ebayUserId: "mock-ebay-user",
    accessToken: "mock-access-token",
    refreshToken: "mock-refresh-token",
    accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    refreshTokenExpiresAt: Date.now() + 47 * 24 * 60 * 60 * 1000,
    scopes: ["https://api.ebay.com/oauth/api_scope"],
    connectedAt: new Date().toISOString(),
  });
}

describe("runtime-path Browse enrichment (fresh purchase with ebayItemId)", () => {
  it("high-confidence purchase with ebayItemId → enriched holding (grader, team, photos, aspects)", async () => {
    const session = await signIn();
    await seedEbayToken("admin-testing-hobbyiq");

    // Seed a fresh eBay purchase carrying an ebayItemId (as fresh imports do
    // post-PR #383). Title alone would auto-create at ~0.85 confidence;
    // Browse enrichment should bump to 0.95 and add team/sport/photos.
    const create = await request(app).post("/api/portfolio/erp/purchases").set("x-session-id", session).send({
      purchaseDate: "2030-01-15T00:00:00Z",
      source: "ebay",
      subtotal: 195,
      tax: 0,
      shipping: 5,
      otherFees: 0,
      vendor: "test-seller",
      notes: "2020 Panini Prizm Mookie Betts #275 PSA 10",
      ebayOrderId: "browse-enriched-1",
      ebayItemId: "407015594876",
    });
    expect(create.status).toBe(201);
    const purchaseId = create.body.purchase.id;

    // Fire the backfill endpoint — same handler runAutoHoldingBatch that the
    // real import loop hits after each eBay import.
    const bfill = await request(app).post("/api/portfolio/erp/purchases/backfill-holdings").set("x-session-id", session);
    expect(bfill.status).toBe(200);
    expect(bfill.body.holdingsCreated).toBeGreaterThanOrEqual(1);
    expect(bfill.body.holdingsBrowseEnriched).toBeGreaterThanOrEqual(1);

    // Assert the resulting holding carries the enrichment fields.
    const holdings = await request(app).get("/api/portfolio/holdings").set("x-session-id", session);
    const created = holdings.body.holdings.find(
      (h: any) => h.playerName === "Mookie Betts" && h.sourcePurchaseId === purchaseId,
    );
    expect(created).toBeTruthy();
    // Browse authoritative on grader / grade
    expect(created.gradeCompany).toBe("PSA");
    expect(created.gradeValue).toBe(10);
    // Backfilled from Browse aspects
    expect(created.team).toBe("Los Angeles Dodgers");
    expect(created.sport).toBe("Baseball");
    expect(created.manufacturer).toBe("Panini");
    // Images assembled from primary + additional
    expect(created.ebayImageUrl).toBe("https://i.ebayimg.com/mock/primary.jpg");
    expect(Array.isArray(created.photos)).toBe(true);
    expect(created.photos.length).toBe(2);
    // Item specifics + description + seller preserved for iOS relist
    expect(created.ebayItemAspects.Player).toBe("Mookie Betts");
    expect(created.ebayShortDescription).toMatch(/GEM MINT/);
    expect(created.ebaySeller.username).toBe("mockseller");
    expect(created.ebayCategoryPath).toMatch(/Baseball Cards/);
    // Confidence bumped, review cleared, enrichment marker set
    // Enrichment bumps confidence to max(prior, 0.95). Title-perfect rows
    // score 1.0 already, so the assertion is a floor.
    expect(created.parseConfidence).toBeGreaterThanOrEqual(0.95);
    expect(created.needsReview).toBe(false);
    expect(created.enrichedFromEbay).toBe(true);
  });

  it("Browse 404 → holding still auto-created via title parse (graceful degrade)", async () => {
    // Rebind fetch so Browse returns 404 for this test, but oauth stays live
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("identity/v1/oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "mock-access",
            refresh_token: "mock-refresh",
            expires_in: 3600,
            refresh_token_expires_in: 47000000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (typeof url === "string" && url.includes("/buy/browse/v1/item/")) {
        return new Response("Not found", { status: 404 });
      }
      return new Response("unexpected fetch: " + url, { status: 500 });
    });

    const session = await signIn();
    await seedEbayToken("admin-testing-hobbyiq");
    const create = await request(app).post("/api/portfolio/erp/purchases").set("x-session-id", session).send({
      purchaseDate: "2030-02-15T00:00:00Z",
      source: "ebay",
      subtotal: 195,
      tax: 0,
      shipping: 5,
      otherFees: 0,
      vendor: "test-seller",
      notes: "2020 Panini Prizm Mookie Betts #275 PSA 10",
      ebayOrderId: "browse-404-1",
      ebayItemId: "999999999999",
    });
    expect(create.status).toBe(201);
    const purchaseId = create.body.purchase.id;

    const bfill = await request(app).post("/api/portfolio/erp/purchases/backfill-holdings").set("x-session-id", session);
    expect(bfill.status).toBe(200);
    // Created via title parse alone
    expect(bfill.body.holdingsCreated).toBeGreaterThanOrEqual(1);

    const holdings = await request(app).get("/api/portfolio/holdings").set("x-session-id", session);
    const created = holdings.body.holdings.find(
      (h: any) => h.sourcePurchaseId === purchaseId,
    );
    expect(created).toBeTruthy();
    expect(created.gradeCompany).toBe("PSA");  // title parse got this
    // But no Browse enrichment fields
    expect(created.enrichedFromEbay).toBeFalsy();
    expect(created.team).toBeFalsy();
    expect(created.photos).toBeFalsy();
  });
});

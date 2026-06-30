/**
 * CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION (2026-06-01) tests.
 *
 * Pre-CF the create + update paths persisted null-identity holdings with
 * 201 OK. Production-observed 2026-06-01 03:22Z reprice on test data:
 * `{playerName: "Paul Skenes"}` -> 201 OK -> repriced via Cardsight's
 * playerName-only search which returned `unavailable` (Skenes, 1 comp)
 * or — worse — a wrong-card $5 (Witt, 22 comps from a popular different
 * card surfaced as if it were the user's holding).
 *
 * The new gate at portfolioStore.service.ts:validateHoldingIdentity
 * requires non-empty `playerName` AND one of:
 *   - non-empty `cardId` alone (identify-then-save flow), OR
 *   - both non-null `cardYear` AND non-empty `product` (free-text flow).
 *
 * Plus a defense-in-depth safety net at repriceHoldingsForUser that
 * skips legacy null-identity rows with a structured warn
 * `repriceHoldingsForUser_skipped_cardless` BEFORE running the
 * Cardsight playerName-only search that produced Witt's wrong $5.
 */
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import {
  repriceHoldingsForUser,
  readUserDoc,
  __portfolioStoreInternals,
} from "../src/services/portfolioiq/portfolioStore.service";

const { writeUserDoc } = __portfolioStoreInternals;

async function signIn(): Promise<string> {
  const r = await request(app)
    .post("/api/auth/signin")
    .send({ username: "HobbyIQ", password: "Baseball25" });
  expect(r.status).toBe(200);
  return r.body.sessionId as string;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────
// Validation gate — addHolding
// ────────────────────────────────────────────────────────────────────────────

describe("addHolding identity validation (POST /api/portfolio/holdings)", () => {
  it("rejects playerName-only with 400 + structured missing-fields list (Skenes/Witt class)", async () => {
    const session = await signIn();
    const res = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "identity-test-skenes-only",
        playerName: "Paul Skenes",
        // No cardYear, product, or cardId — the production
        // failure shape that landed 201 OK pre-CF.
      });

    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe("MISSING_IDENTITY_FIELDS");
    expect(res.body?.error?.missing).toEqual(["cardYear", "product"]);
    expect(typeof res.body?.error?.message).toBe("string");
    expect(typeof res.body?.error?.hint).toBe("string");
    // Hint surfaces both satisfying-shape options (cardYear+product OR cardId).
    expect(res.body.error.hint).toMatch(/cardId/);
  });

  it("missing playerName too: missing[] surfaces playerName first (stable spec order)", async () => {
    const session = await signIn();
    const res = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "identity-test-no-player",
        playerName: "",
        cardYear: 2024,
        product: "Bowman Chrome",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_IDENTITY_FIELDS");
    expect(res.body.error.missing).toEqual(["playerName"]);
  });

  it("accepts cardId-only as a valid identity-bearing shape (identify-then-save flow)", async () => {
    const session = await signIn();
    const res = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "identity-test-csid-only",
        playerName: "Paul Skenes",
        // No cardYear or product, but Cardsight UUID is present.
        // This is the identify-then-save flow: iOS got a UUID back
        // from POST /identify and saves without filling in text fields.
        cardId: "b676dee0-3ec0-4a15-af9f-8dfd3e73b039",
      });

    expect([200, 201]).toContain(res.status);
  });

  it("accepts full identity (playerName + cardYear + product, no csid)", async () => {
    const session = await signIn();
    const res = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "identity-test-full",
        playerName: "Mike Trout",
        cardYear: 2011,
        product: "Topps Update",
      });

    expect(res.status).toBe(201);
  });

  it("rejects cardYear without product (free-text shape requires BOTH)", async () => {
    const session = await signIn();
    const res = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "identity-test-year-only",
        playerName: "Mike Trout",
        cardYear: 2011,
        // No product, no cardId.
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_IDENTITY_FIELDS");
    expect(res.body.error.missing).toEqual(["product"]);
  });

  it("rejects product without cardYear (free-text shape requires BOTH)", async () => {
    const session = await signIn();
    const res = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "identity-test-product-only",
        playerName: "Mike Trout",
        product: "Topps Update",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_IDENTITY_FIELDS");
    expect(res.body.error.missing).toEqual(["cardYear"]);
  });

  it("rejects empty-string cardId (treated as absent)", async () => {
    const session = await signIn();
    const res = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "identity-test-csid-empty",
        playerName: "Paul Skenes",
        cardId: "",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_IDENTITY_FIELDS");
    expect(res.body.error.missing).toEqual(["cardYear", "product"]);
  });

  it("rejects cardYear=0 (free-text shape requires a positive year)", async () => {
    const session = await signIn();
    const res = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: "identity-test-year-zero",
        playerName: "Mike Trout",
        cardYear: 0,
        product: "Topps Update",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_IDENTITY_FIELDS");
    expect(res.body.error.missing).toEqual(["cardYear"]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Validation gate — updateHolding (symmetric, validates merged AFTER state)
// ────────────────────────────────────────────────────────────────────────────

describe("updateHolding identity validation (PATCH /api/portfolio/holdings/:id)", () => {
  it("PATCH that adds cardYear + product to a holding that already has them: passes", async () => {
    const session = await signIn();
    const holdingId = "identity-update-passes";
    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Mike Trout",
        cardYear: 2011,
        product: "Topps Update",
      });

    const patch = await request(app)
      .patch(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session)
      .send({ quantity: 2 });

    expect([200, 204]).toContain(patch.status);
  });

  it("PATCH that tries to BLANK playerName: rejected (merged AFTER state misses required field)", async () => {
    const session = await signIn();
    const holdingId = "identity-update-blank-player";
    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Mike Trout",
        cardYear: 2011,
        product: "Topps Update",
      });

    const patch = await request(app)
      .patch(`/api/portfolio/holdings/${holdingId}`)
      .set("x-session-id", session)
      .send({ playerName: "" });

    expect(patch.status).toBe(400);
    expect(patch.body.error.code).toBe("MISSING_IDENTITY_FIELDS");
    expect(patch.body.error.missing).toEqual(["playerName"]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Defense-in-depth — repriceHoldingsForUser safety net
// ────────────────────────────────────────────────────────────────────────────

describe("repriceHoldingsForUser safety net for legacy null-identity rows", () => {
  it("skips a cardless holding with structured warn; does NOT call Cardsight playerName-only path", async () => {
    // Inject a cardless holding directly via the write-doc path used
    // internally — bypassing the validation gate so we can model the
    // legacy/edge-row condition the safety net is meant to catch.
const userId = "test-reprice-cardless-user";
    const doc = await readUserDoc(userId);
    const holdingId = "legacy-cardless-row";
    (doc.holdings as Record<string, any>)[holdingId] = {
      id: holdingId,
      playerName: "Paul Skenes",
      // Intentionally null/missing identity — the legacy shape.
      cardYear: null,
      product: null,
      cardId: null,
      quantity: 1,
      purchasePrice: 100,
      totalCostBasis: 100,
      lastUpdated: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    };
    await writeUserDoc(userId, doc);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await repriceHoldingsForUser(userId, "test-cardless-skip");

    // The cardless row was skipped (not repriced, not errored).
    expect(result.repriced).toBe(0);
    expect(result.skipped).toBe(1);

    // Structured warn fired with the load-bearing shape the
    // skip-rate KQL will consume.
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    const event = warnCalls.find((s) =>
      s.includes("repriceHoldingsForUser_skipped_cardless")
    );
    expect(event).toBeTruthy();
    const parsed = JSON.parse(event!);
    expect(parsed.event).toBe("repriceHoldingsForUser_skipped_cardless");
    expect(parsed.source).toBe("portfolioStore.service");
    expect(parsed.holdingId).toBe(holdingId);
    expect(parsed.userId).toBe(userId);
    expect(parsed.reason).toBe("missing_card_identity");
    expect(parsed.playerName).toBe("Paul Skenes");

    // Load-bearing: the per-holding `updates[]` array records the skip
    // with a stable reason string for any downstream telemetry.
    const update = result.updates.find((u) => u.id === holdingId);
    expect(update).toBeTruthy();
    expect(update?.status).toBe("skipped");
    expect(String(update?.reason)).toMatch(/missing_card_identity/);

    warnSpy.mockRestore();
  });

  it("cardId-only legacy row: NOT skipped by the safety net (csid provides identity)", async () => {
const userId = "test-reprice-csid-only-user";
    const doc = await readUserDoc(userId);
    const holdingId = "legacy-csid-only-row";
    (doc.holdings as Record<string, any>)[holdingId] = {
      id: holdingId,
      playerName: "Paul Skenes",
      cardYear: null,
      product: null,
      cardId: "b676dee0-3ec0-4a15-af9f-8dfd3e73b039",
      quantity: 1,
      purchasePrice: 100,
      totalCostBasis: 100,
      lastUpdated: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    };
    await writeUserDoc(userId, doc);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await repriceHoldingsForUser(userId, "test-csid-survives");

    // The safety net only skips when BOTH cardYear is null AND
    // cardId is null. Csid-only legacy rows fall through
    // to the normal repricing path (where computeEstimate decides
    // its own pass/skip based on comp data — out of scope for this test).
    const update = result.updates.find((u) => u.id === holdingId);
    expect(update?.reason ?? "").not.toMatch(/missing_card_identity/);

    // No safety-net warn fired for this holding.
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    const cardlessWarn = warnCalls.find(
      (s) =>
        s.includes("repriceHoldingsForUser_skipped_cardless") &&
        s.includes(holdingId)
    );
    expect(cardlessWarn).toBeFalsy();

    warnSpy.mockRestore();
  });
});

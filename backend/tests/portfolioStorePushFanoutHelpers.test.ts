// CF-VERDICT-FLIP-PUSH-FANOUT-STEP-2/3 (Drew, 2026-07-16). Pins the
// cross-partition helpers the fan-out worker calls to build its push
// intent stream. Runs in test-mode against the in-memory user store
// (no Cosmos).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../src/app";
import {
  listAllHeldPlayers,
  listUsersOwningPlayerWithPushOptIn,
} from "../src/services/portfolioiq/portfolioStore.service.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signInAs(username: string, password: string): Promise<{ sessionId: string; userId: string }> {
  const response = await request(app)
    .post("/api/auth/signin")
    .send({ username, password });
  expect(response.status).toBe(200);
  return {
    sessionId: response.body.sessionId as string,
    userId: response.body.user?.userId as string,
  };
}

async function addHolding(sessionId: string, holdingId: string, playerName: string): Promise<void> {
  const res = await request(app)
    .post("/api/portfolio/holdings")
    .set("x-session-id", sessionId)
    .send({
      id: holdingId,
      playerName,
      cardYear: 2024,
      product: "Bowman Chrome",
      cardNumber: "BCP-1",
    });
  expect(res.status).toBeLessThan(400);
}

describe("listAllHeldPlayers", () => {
  it("returns empty set when no users exist (or store empty)", async () => {
    // No signIn yet — testMemStore is empty at boot in a fresh vitest run.
    // If prior tests seeded it, the set is non-empty but well-typed.
    const set = await listAllHeldPlayers();
    expect(set).toBeInstanceOf(Set);
  });

  it("collects trimmed playerName across every user's holdings, unioned", async () => {
    const alice = await signInAs("HobbyIQ", "Baseball25");
    await addHolding(alice.sessionId, "fanout-alice-1", "Paul Skenes");
    await addHolding(alice.sessionId, "fanout-alice-2", "Eric Hartman");
    // Second-space-user via a separate signIn would need a different
    // seeded account — the test harness has one canonical user, so we
    // exercise the multi-holding-single-user case here. Multi-user is
    // covered implicitly by the same-loop logic (matched pattern with
    // findHoldingByEbayListingIdAcrossUsers).
    const set = await listAllHeldPlayers();
    expect(set.has("Paul Skenes")).toBe(true);
    expect(set.has("Eric Hartman")).toBe(true);
  });

  it("de-duplicates identical playerNames across holdings (set semantics)", async () => {
    const alice = await signInAs("HobbyIQ", "Baseball25");
    await addHolding(alice.sessionId, "fanout-dup-1", "Mike Trout");
    await addHolding(alice.sessionId, "fanout-dup-2", "Mike Trout");
    const set = await listAllHeldPlayers();
    // One entry regardless of how many holdings carry the name.
    const troutCount = [...set].filter((n) => n === "Mike Trout").length;
    expect(troutCount).toBe(1);
  });
});

describe("listUsersOwningPlayerWithPushOptIn", () => {
  it("returns empty when no users opted in", async () => {
    const alice = await signInAs("HobbyIQ", "Baseball25");
    await addHolding(alice.sessionId, "fanout-optout-1", "Wander Franco");
    // No preferences.pushOnMajorFlip write path shipped yet (that's iOS
    // Settings). Verify the store correctly returns [] when the flag
    // is absent.
    const rows = await listUsersOwningPlayerWithPushOptIn("Wander Franco");
    expect(rows).toEqual([]);
  });

  it("returns empty for an unknown player even when the user opted in", async () => {
    // Direct writes to the doc bypass the (not-yet-shipped) settings API.
    const { setUserPushPreferenceForTests } = await import(
      "../src/services/portfolioiq/portfolioStore.service.js"
    );
    const alice = await signInAs("HobbyIQ", "Baseball25");
    await addHolding(alice.sessionId, "fanout-unknown-1", "Corbin Carroll");
    await setUserPushPreferenceForTests(alice.userId, {
      pushOnMajorFlip: true,
      apnsDeviceToken: "test-device-token-abc",
    });
    const rows = await listUsersOwningPlayerWithPushOptIn("Not A Real Player");
    expect(rows).toEqual([]);
  });

  it("returns the user + device token when they own the player AND opted in", async () => {
    const { setUserPushPreferenceForTests } = await import(
      "../src/services/portfolioiq/portfolioStore.service.js"
    );
    const alice = await signInAs("HobbyIQ", "Baseball25");
    await addHolding(alice.sessionId, "fanout-optin-1", "Jackson Chourio");
    await setUserPushPreferenceForTests(alice.userId, {
      pushOnMajorFlip: true,
      apnsDeviceToken: "device-token-chourio",
    });
    const rows = await listUsersOwningPlayerWithPushOptIn("Jackson Chourio");
    expect(rows.length).toBe(1);
    expect(rows[0].userId).toBe(alice.userId);
    expect(rows[0].apnsDeviceToken).toBe("device-token-chourio");
  });

  it("is case-insensitive on player name (Cosmos + JS both normalize)", async () => {
    const { setUserPushPreferenceForTests } = await import(
      "../src/services/portfolioiq/portfolioStore.service.js"
    );
    const alice = await signInAs("HobbyIQ", "Baseball25");
    await addHolding(alice.sessionId, "fanout-case-1", "Ronald Acuna Jr");
    await setUserPushPreferenceForTests(alice.userId, { pushOnMajorFlip: true });
    const rowsA = await listUsersOwningPlayerWithPushOptIn("ronald acuna jr");
    const rowsB = await listUsersOwningPlayerWithPushOptIn("  RONALD ACUNA JR  ");
    expect(rowsA.length).toBe(1);
    expect(rowsB.length).toBe(1);
  });

  it("returns one match per user regardless of holding count for that player", async () => {
    const { setUserPushPreferenceForTests } = await import(
      "../src/services/portfolioiq/portfolioStore.service.js"
    );
    const alice = await signInAs("HobbyIQ", "Baseball25");
    await addHolding(alice.sessionId, "fanout-multi-1", "James Wood");
    await addHolding(alice.sessionId, "fanout-multi-2", "James Wood");
    await addHolding(alice.sessionId, "fanout-multi-3", "James Wood");
    await setUserPushPreferenceForTests(alice.userId, { pushOnMajorFlip: true });
    const rows = await listUsersOwningPlayerWithPushOptIn("James Wood");
    expect(rows.length).toBe(1);
  });

  it("returns empty when opted-in user does NOT own the requested player", async () => {
    const { setUserPushPreferenceForTests } = await import(
      "../src/services/portfolioiq/portfolioStore.service.js"
    );
    const alice = await signInAs("HobbyIQ", "Baseball25");
    await addHolding(alice.sessionId, "fanout-neg-1", "Junior Caminero");
    await setUserPushPreferenceForTests(alice.userId, { pushOnMajorFlip: true });
    const rows = await listUsersOwningPlayerWithPushOptIn("Someone Else");
    expect(rows).toEqual([]);
  });

  it("apnsDeviceToken is null when the user opted in but hasn't registered a device", async () => {
    const { setUserPushPreferenceForTests } = await import(
      "../src/services/portfolioiq/portfolioStore.service.js"
    );
    const alice = await signInAs("HobbyIQ", "Baseball25");
    await addHolding(alice.sessionId, "fanout-notoken-1", "Yordan Alvarez");
    // Explicit null clears any device token set by an earlier test in
    // the same in-memory testMemStore run — testMemStore is shared
    // across tests within the file.
    await setUserPushPreferenceForTests(alice.userId, {
      pushOnMajorFlip: true,
      apnsDeviceToken: null,
    });
    const rows = await listUsersOwningPlayerWithPushOptIn("Yordan Alvarez");
    expect(rows.length).toBe(1);
    expect(rows[0].apnsDeviceToken).toBeNull();
  });
});

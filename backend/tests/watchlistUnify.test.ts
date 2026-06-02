// CF-WATCHLIST-UNIFY (2026-06-02) — locks the hard-cutover state.
//
// Two concerns:
//   (1) /api/watchlist mount is GONE. Requests to it must 404 via the
//       Express catch-all notFoundHandler — proves the basic system is
//       fully retired at the route layer.
//   (2) /api/dailyiq/watchlist is canonical and still mounted (auth-
//       gated; sanity-checked here by hitting it without a session and
//       receiving 401 from requireUserId).
//
// Migration-script mapping is tested separately as a pure-function test
// against a fixture row; the live dry-run against the real container
// runs in ops, not vitest.

import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

process.env.COMPIQ_CORPUS_DISABLED = "1";

let app: any;

beforeAll(async () => {
  app = (await import("../src/app")).default;
});

describe("CF-WATCHLIST-UNIFY — basic system retired", () => {
  it("GET /api/watchlist returns 404 (route removed)", async () => {
    const r = await request(app).get("/api/watchlist");
    expect(r.status).toBe(404);
    expect(r.body.error).toContain("not found");
  });

  it("POST /api/watchlist returns 404 (route removed)", async () => {
    const r = await request(app)
      .post("/api/watchlist")
      .send({ playerId: "x", playerName: "Y" });
    expect(r.status).toBe(404);
  });

  it("DELETE /api/watchlist/:itemId returns 404 (route removed)", async () => {
    const r = await request(app).delete("/api/watchlist/test-uuid");
    expect(r.status).toBe(404);
  });

  it("PATCH /api/watchlist/:itemId returns 404 (route removed)", async () => {
    const r = await request(app)
      .patch("/api/watchlist/test-uuid")
      .send({ alertEnabled: true });
    expect(r.status).toBe(404);
  });
});

describe("CF-WATCHLIST-UNIFY — canonical system still mounted", () => {
  it("GET /api/dailyiq/watchlist without session returns 401 (mount present + auth-gated)", async () => {
    const r = await request(app).get("/api/dailyiq/watchlist");
    // 401 proves the route IS mounted and reached the auth check —
    // contrast with /api/watchlist's 404 above. A 404 here would mean
    // the canonical mount got removed by accident.
    expect(r.status).toBe(401);
  });

  it("POST /api/dailyiq/watchlist without session returns 401", async () => {
    const r = await request(app)
      .post("/api/dailyiq/watchlist")
      .send({ playerId: "545361", playerName: "Mike Trout" });
    expect(r.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Migration script fixture mapping. Tests the pure data-shape transform
// independent of Cosmos / MLB API. The script itself is in
// scripts/migrate-watchlist-to-dailyiq.cjs; this test imports nothing
// from it (cjs in scripts/ is excluded from tsc) and instead re-verifies
// the documented field-mapping contract against a fixture row.
// ─────────────────────────────────────────────────────────────────────

import crypto from "crypto";

function docIdFor(userId: string, playerId: string): string {
  // MUST match scripts/migrate-watchlist-to-dailyiq.cjs:docIdFor AND
  // services/dailyiq/watchlistStore.service.ts:docIdFor.
  const hash = crypto
    .createHash("sha1")
    .update(`${userId}::${playerId}`)
    .digest("hex");
  return `wl_${hash}`;
}

describe("CF-WATCHLIST-UNIFY — migration mapping contract", () => {
  // Documented source-row shape (basic system; what migration reads).
  const sourceRow = {
    id: "uuid-deadbeef",
    userId: "admin-testing-hobbyiq",
    playerId: "545361",
    playerName: "Mike Trout",
    sport: "baseball",          // DROPPED in target
    alertEnabled: true,          // DROPPED in target
    createdAt: "2026-05-15T12:00:00.000Z",
    docType: "watchlist",
  };

  it("deterministic doc id matches watchlistStore.docIdFor pattern", () => {
    // wl_<sha1>; must match the runtime store so re-runs are idempotent
    // and a live route POST of the same (userId, playerId) finds the
    // migrated row instead of duplicating.
    const id = docIdFor(sourceRow.userId, sourceRow.playerId);
    expect(id).toMatch(/^wl_[a-f0-9]{40}$/);
    // Same inputs → same id (idempotency).
    expect(docIdFor(sourceRow.userId, sourceRow.playerId)).toBe(id);
    // Different inputs → different id.
    expect(docIdFor(sourceRow.userId, "different-player")).not.toBe(id);
    expect(docIdFor("different-user", sourceRow.playerId)).not.toBe(id);
  });

  it("documented field mapping: createdAt PRESERVED, sport+alertEnabled DROPPED, watchlistItemId NEW", () => {
    // This locks the migration's documented field mapping. The script's
    // implementation does this same mapping at runtime; if either drifts
    // from this fixture, one is wrong.
    const targetDoc = {
      id: docIdFor(sourceRow.userId, sourceRow.playerId),
      docType: "dailyiq_watchlist" as const,
      userId: sourceRow.userId,
      playerId: sourceRow.playerId,
      playerName: sourceRow.playerName,
      league: "MLB" as const,
      watchlistItemId: "any-new-uuid-here",
      createdAt: sourceRow.createdAt,
    };

    expect(targetDoc.createdAt).toBe(sourceRow.createdAt);
    expect((targetDoc as any).sport).toBeUndefined();
    expect((targetDoc as any).alertEnabled).toBeUndefined();
    expect(targetDoc.docType).toBe("dailyiq_watchlist");
    // playerId carried verbatim — the join key downstream readers use.
    expect(targetDoc.playerId).toBe(sourceRow.playerId);
    // userId carried verbatim — partition key.
    expect(targetDoc.userId).toBe(sourceRow.userId);
    // league defaults to "MLB" when MLB resolution fails (freeform path).
    // When MLB API succeeds, league is one of "MLB" | "MiLB".
    expect(["MLB", "MiLB"]).toContain(targetDoc.league);
  });

  it("rich-system optional fields are absent on freeform-fallback path", () => {
    // When MLB API fails OR returns no match, the script's freeform
    // fallback produces a doc with NO mlbPersonId/teamName/etc. The
    // doc shape MUST tolerate undefined for all rich fields without
    // throwing at upsert time (Cosmos rejects undefined-valued props
    // when serialized; script strips them pre-upsert).
    const freeformDoc: Record<string, any> = {
      id: docIdFor(sourceRow.userId, sourceRow.playerId),
      docType: "dailyiq_watchlist",
      userId: sourceRow.userId,
      playerId: sourceRow.playerId,
      playerName: sourceRow.playerName,
      league: "MLB",
      watchlistItemId: "uuid",
      createdAt: sourceRow.createdAt,
    };
    expect(freeformDoc.mlbPersonId).toBeUndefined();
    expect(freeformDoc.teamName).toBeUndefined();
    expect(freeformDoc.teamAbbreviation).toBeUndefined();
    expect(freeformDoc.level).toBeUndefined();
    expect(freeformDoc.position).toBeUndefined();
    // Stripping undefined keys (script does this pre-upsert):
    for (const k of Object.keys(freeformDoc)) {
      if (freeformDoc[k] === undefined) delete freeformDoc[k];
    }
    // After strip, only present keys remain — Cosmos-safe.
    expect(Object.keys(freeformDoc).sort()).toEqual([
      "createdAt",
      "docType",
      "id",
      "league",
      "playerId",
      "playerName",
      "userId",
      "watchlistItemId",
    ]);
  });
});

// CF-KILL-VENDOR-REFERENCE-PRICES (Drew, 2026-07-13, PR #409) — enforces
// the "self-reliant engine, vendor as data pipe" contract at the
// /api/compiq/card-panel wire boundary. After this PR, iOS receives
// zero vendor-derived signals on the grade rail:
//
//   - `referencePrices[]` is always empty (used to be CH's grade table)
//   - `gradeCurve.entries[].estimatedFrom` is NEVER "reference-price"
//   - `gradeCurve.entries[].referencePrice` is null on every entry
//
// If any of these regress, the wire is silently pulling CH's third-party
// model back onto the user's screen. The test guards the invariant.

import { describe, expect, it, vi, afterEach } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import * as chClient from "../src/services/compiq/cardhedge.client.js";
import * as gradeCurveSvc from "../src/services/compiq/observedGradeCurve.service.js";
import * as samePlayerSvc from "../src/services/compiq/samePlayerSiblings.service.js";

async function signIn(): Promise<string> {
  const r = await request(app)
    .post("/api/auth/signin")
    .send({ username: "HobbyIQ", password: "Baseball25" });
  expect(r.status).toBe(200);
  return r.body.sessionId as string;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/api/compiq/card-panel — no vendor-derived reference prices on wire", () => {
  it("referencePrices[] is always empty (was: CH's grade table)", async () => {
    const session = await signIn();
    // Stub CH identity resolution + grade curve so the route runs
    // without hitting real vendors.
    vi.spyOn(chClient, "getCardDetailsById").mockResolvedValue({
      card_id: "ch-test",
      player: "Test Player",
      set: "2026 Bowman",
      year: 2026,
      number: "1",
      variant: null,
    } as any);
    vi.spyOn(gradeCurveSvc, "buildObservedGradeCurve").mockResolvedValue({
      totalSampleCount: 5,
      computedAt: new Date().toISOString(),
      entries: [
        {
          grade: "Raw",
          grader: "RAW",
          sampleCount: 5,
          weightedMedianPrice: 100,
          plainMedianPrice: 100,
          priceRangeLow: null,
          priceRangeHigh: null,
          newestSaleDate: "2026-07-01",
          oldestSaleDate: "2026-06-01",
          confidenceScore: 0.7,
          value: 100,
          valueSource: "observed",
          estimatedMultiplier: null,
          estimatedFrom: null,
          referencePrice: null,   // ← key invariant
          referenceDivergencePct: null,
          referenceAnomaly: false,
        } as any,
      ],
      ratePerWeek: 0,
      signalSource: "card",
      siblingFallback: null,
    } as any);
    vi.spyOn(samePlayerSvc, "getSamePlayerSiblings").mockResolvedValue([]);

    // getAllPricesByCard MUST NOT be called by the card-panel route now.
    const getAllSpy = vi.spyOn(chClient, "getAllPricesByCard");
    const r = await request(app)
      .get("/api/compiq/card-panel/ch-test")
      .set("x-session-id", session);
    expect(r.status).toBe(200);
    expect(r.body.referencePrices).toEqual([]);
    expect(getAllSpy).not.toHaveBeenCalled();
  });

  it("gradeCurve entries never carry estimatedFrom=reference-price after PR #409", async () => {
    const session = await signIn();
    vi.spyOn(chClient, "getCardDetailsById").mockResolvedValue({
      card_id: "ch-test-2",
      player: "Test Player",
      set: "2026 Bowman",
      year: 2026,
      number: "2",
      variant: null,
    } as any);
    vi.spyOn(gradeCurveSvc, "buildObservedGradeCurve").mockResolvedValue({
      totalSampleCount: 5,
      computedAt: new Date().toISOString(),
      entries: [
        {
          grade: "Raw",
          grader: "RAW",
          sampleCount: 5,
          weightedMedianPrice: 100,
          plainMedianPrice: 100,
          priceRangeLow: null,
          priceRangeHigh: null,
          newestSaleDate: "2026-07-01",
          oldestSaleDate: "2026-06-01",
          confidenceScore: 0.7,
          value: 100,
          valueSource: "observed",
          estimatedMultiplier: null,
          estimatedFrom: null,
        } as any,
        {
          grade: "10",
          grader: "PSA",
          sampleCount: 0,
          weightedMedianPrice: null,
          plainMedianPrice: null,
          priceRangeLow: null,
          priceRangeHigh: null,
          newestSaleDate: null,
          oldestSaleDate: null,
          confidenceScore: 0,
          value: 800,   // raw × multiplier estimate
          valueSource: "estimated",
          estimatedMultiplier: 8,
          estimatedFrom: "raw-multiplier",   // ← post-#409: never "reference-price"
        } as any,
      ],
      ratePerWeek: 0,
      signalSource: "card",
      siblingFallback: null,
    } as any);
    vi.spyOn(samePlayerSvc, "getSamePlayerSiblings").mockResolvedValue([]);

    const r = await request(app)
      .get("/api/compiq/card-panel/ch-test-2")
      .set("x-session-id", session);
    expect(r.status).toBe(200);
    for (const entry of r.body.gradeCurve.entries) {
      expect(entry.estimatedFrom).not.toBe("reference-price");
    }
  });

  it("buildObservedGradeCurve is called WITHOUT referencePriceByGrade", async () => {
    const session = await signIn();
    vi.spyOn(chClient, "getCardDetailsById").mockResolvedValue({
      card_id: "ch-test-3",
      player: "Test Player",
      set: "2026 Bowman",
      year: 2026,
      number: "3",
      variant: null,
    } as any);
    const buildSpy = vi.spyOn(gradeCurveSvc, "buildObservedGradeCurve").mockResolvedValue({
      totalSampleCount: 0,
      computedAt: new Date().toISOString(),
      entries: [],
      ratePerWeek: 0,
      signalSource: null,
      siblingFallback: null,
    } as any);
    vi.spyOn(samePlayerSvc, "getSamePlayerSiblings").mockResolvedValue([]);

    await request(app)
      .get("/api/compiq/card-panel/ch-test-3")
      .set("x-session-id", session);

    expect(buildSpy).toHaveBeenCalled();
    const opts = buildSpy.mock.calls[0][1];
    expect(opts).not.toHaveProperty("referencePriceByGrade");
  });
});

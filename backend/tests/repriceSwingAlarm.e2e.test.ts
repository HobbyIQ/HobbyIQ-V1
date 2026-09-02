/**
 * CF-A-SWING-IS-NOT-A-MARKET / E2E WIRING (2026-09-01).
 *
 * The adversarial verify on #1627 proved the unit suite could not see the
 * feature die: repriceSwingAlarm.test.ts imports only the pure helpers
 * (perUnitFmvForSwing / swingRatio / isSwingAlarming), so mutating the CAPTURE
 * in repriceHoldingsForUser to `priorFmv.set(h.id, null)` — which kills the
 * alarm outright in production, since a null `from` can never be alarming —
 * left all 8 tests green. The helpers were pinned; the WIRING was not.
 *
 * This file pins the wiring, end to end, through the real scheduled path:
 * POST /api/portfolio/reprice/batch -> repriceHoldingsForUser -> the post-loop
 * swing sweep -> the portfolio_reprice_value_swing warning on stdout.
 *
 * The two cases are the measured ones from holding 9b971b03 (RA-JC):
 *   seed 20.625 -> reprice 213.8  (10.37x)  -> alarm, exactly once
 *   seed 106    -> reprice 131.88 (1.24x)   -> silent
 *
 * And the value is PERSISTED either way — persisted:true on the event, and
 * the stored fairMarketValue is the new number. A swing is observed, never
 * clamped (feedback_grade_monotonicity_is_not_an_invariant).
 *
 * Harness pattern from repriceHoldingsForUser.pinnedAuthoritative.test.ts:
 * /reprice/batch dispatches async and answers 202, so settle the tracked run
 * before inspecting anything.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { readUserDoc, writeUserDoc } from "../src/services/portfolioiq/portfolioStore.service.js";
import * as repriceJobs from "../src/services/portfolioiq/repriceJobTracker.js";

process.env.COMPIQ_CORPUS_DISABLED = "1";
process.env.PORTFOLIO_REPRICE_HTTP_MIN_AGE_MS = "1";
process.env.PORTFOLIO_REPRICE_HTTP_THROTTLE_MS = "1";

const NOW_ISO_FIXED = "2026-09-01T20:00:00.000Z";

// The FMV the reprice site will compute, set per-test before dispatch.
let nextFmv = 213.8;

vi.mock("../src/services/compiq/compiqEstimate.service.js", async () => {
  const actual = await vi.importActual<any>(
    "../src/services/compiq/compiqEstimate.service.js",
  );
  return {
    ...actual,
    computeEstimate: vi.fn(async () => ({
      fairMarketValue: nextFmv,
      premiumValue: nextFmv * 1.15,
      quickSaleValue: nextFmv * 0.85,
      marketDNA: { trend: "flat", speed: "Normal", marketCondition: "Balanced Market" },
      confidence: { pricingConfidence: 90 },
      source: "live",
      verdict: "Hold",
      action: "Hold",
      compsUsed: 18,
      compsAvailable: 22,
      recentComps: [],
      cardIdentity: { card_id: "swing-e2e-card", year: 2026, release: "Topps Chrome" },
      gradeUsed: "Raw",
      daysSinceNewestComp: 1,
      variantWarning: [],
      effectiveFmv: nextFmv,
      predictedPrice: nextFmv,
      predictedPriceRange: { low: nextFmv * 0.9, high: nextFmv * 1.1 },
      predictedPriceAttribution: { mechanism: "trendiq-projection" },
      signalsLastUpdated: NOW_ISO_FIXED,
    })),
  };
});

let app: any;

beforeAll(async () => {
  app = (await import("../src/app")).default;
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function signIn(): Promise<{ sessionId: string; userId: string }> {
  const res = await request(app)
    .post("/api/auth/signin")
    .send({ username: "HobbyIQ", password: "Baseball25" });
  expect(res.status).toBe(200);
  return { sessionId: res.body.sessionId as string, userId: res.body.user?.userId as string };
}

async function seedHolding(userId: string, holdingId: string, fmv: number): Promise<void> {
  const doc = await readUserDoc(userId);
  doc.holdings[holdingId] = {
    id: holdingId,
    quantity: 1,
    purchasePrice: 50,
    totalCostBasis: 50,
    cardStatus: "active",
    playerName: "Roman Anthony",
    cardYear: 2026,
    product: "Topps Chrome",
    cardNumber: "RA-JC",
    // A RESOLVED identity. withholdPricesFromUnidentifiedHoldings() nulls the
    // price at write time for any holding carrying neither cardId nor
    // hobbyiqCardId, so an unidentified fixture would store null and the
    // persisted-value assertions below would be measuring the withhold, not
    // the reprice.
    hobbyiqCardId: "hiq:baseball:2026:topps-chrome:ra-jc:refractor:auto",
    // The value this cycle will move AWAY from — the `from` side of the swing.
    fairMarketValue: fmv,
    valuationStatus: "observed",
    lastUpdated: "2026-09-01T00:00:00.000Z",
  } as any;
  await writeUserDoc(userId, doc);
}

/** Dispatch the scheduled path and wait for the tracked run to settle. */
async function repriceAndSettle(sessionId: string, userId: string) {
  const res = await request(app)
    .post("/api/portfolio/reprice/batch")
    .set("x-session-id", sessionId)
    .send({});
  expect(res.status).toBe(202);
  expect(res.body.accepted).toBe(true);
  await repriceJobs.__awaitSettledForTests(userId, 30_000);
  const job = repriceJobs.getJob(userId);
  expect(job?.status, `reprice run errored: ${job?.error}`).toBe("done");
  return job!.result!;
}

/** The swing events this run emitted for one holding. */
function swingEventsFor(warn: any, holdingId: string) {
  return warn.mock.calls
    .map((c: any[]) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
    .filter((e: any) => e?.event === "portfolio_reprice_value_swing" && e?.holdingId === holdingId);
}

describe("E2E — portfolio_reprice_value_swing fires through repriceHoldingsForUser", () => {
  it("THE RA-JC SWING: seeded 20.625, repriced to 213.8 -> alarms exactly once, and persists", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = `swing-loud-${Date.now()}`;
    await seedHolding(userId, holdingId, 20.625);
    nextFmv = 213.8;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await repriceAndSettle(sessionId, userId);
    const events = swingEventsFor(warn, holdingId);
    warn.mockRestore();

    // THE WIRING ASSERTION. Under the verifier's `priorFmv.set(h.id, null)`
    // mutation this is 0 — the alarm is dead in production and this pin is
    // the only thing that says so.
    expect(events, "no portfolio_reprice_value_swing emitted for a 10.37x move").toHaveLength(1);

    const e = events[0];
    expect(e.from).toBeCloseTo(20.625, 3);
    expect(e.to).toBeCloseTo(213.8, 3);
    expect(e.ratio).toBeCloseTo(10.37, 2);
    expect(e.threshold).toBe(2);
    // Observed, never clamped: the alarm says the value was kept...
    expect(e.persisted).toBe(true);
    expect(e.holdingId).toBe(holdingId);
    expect(e.userId).toBe(userId);

    // ...and the store agrees — the swung value really is what we stored.
    const doc = await readUserDoc(userId);
    expect((doc.holdings[holdingId] as any).fairMarketValue).toBeCloseTo(213.8, 3);
  }, 60_000);

  it("AN ORDINARY MOVE IS SILENT: seeded 106, repriced to 131.88 (1.24x) -> no alarm, still persisted", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = `swing-quiet-${Date.now()}`;
    await seedHolding(userId, holdingId, 106);
    nextFmv = 131.88;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await repriceAndSettle(sessionId, userId);
    const events = swingEventsFor(warn, holdingId);
    warn.mockRestore();

    expect(events, "a 1.24x move must not alarm").toHaveLength(0);

    const doc = await readUserDoc(userId);
    expect((doc.holdings[holdingId] as any).fairMarketValue).toBeCloseTo(131.88, 3);
  }, 60_000);
});

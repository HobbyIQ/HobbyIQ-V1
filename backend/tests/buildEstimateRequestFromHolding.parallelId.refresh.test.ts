/**
 * CF-HOLDING-REFRESH-PARALLELID-THREAD (2026-06-26) — integration test
 * for the scheduled-reprice path. Mirrors
 * `repriceHoldingsForUser.pinnedAuthoritative.test.ts`: mocks
 * computeEstimate to capture its body argument, exercises the
 * `/api/portfolio/reprice/batch` route, and asserts that holdings with
 * a stored `parallelId` thread it all the way through to the engine.
 *
 * NOTE on test-runner noise: this file imports the Express `app`, which
 * pulls in `routes/subscriptions.routes.ts` and the unrelated
 * `@apple/app-store-server-library` missing-module error pre-existing on
 * this branch (same root cause as the failing CI "Backend Unit Tests"
 * check). The unit tests for the builder live in a sibling file
 * (`buildEstimateRequestFromHolding.parallelId.test.ts`) that doesn't
 * import `app` so it always runs.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import {
  readUserDoc,
  writeUserDoc,
} from "../src/services/portfolioiq/portfolioStore.service.js";

process.env.COMPIQ_CORPUS_DISABLED = "1";
process.env.PORTFOLIO_REPRICE_HTTP_MIN_AGE_MS = "1";
process.env.PORTFOLIO_REPRICE_HTTP_THROTTLE_MS = "1";

const HARTMAN_PARENT = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";
const GREEN_SHIMMER_PARALLEL_ID = "c1cea15f-5513-43cf-bc32-03d015fe80b1";

vi.mock("../src/services/compiq/compiqEstimate.service.js", async () => {
  const actual = await vi.importActual<any>(
    "../src/services/compiq/compiqEstimate.service.js",
  );
  return {
    ...actual,
    computeEstimate: vi.fn(async () => ({
      fairMarketValue: 250,
      premiumValue: 280,
      quickSaleValue: 220,
      marketDNA: { trend: "flat", speed: "Normal", marketCondition: "Balanced Market" },
      confidence: { pricingConfidence: 90 },
      source: "live",
      verdict: "Hold",
      action: "Hold",
      compsUsed: 11,
      compsAvailable: 11,
      recentComps: [],
      cardIdentity: { card_id: HARTMAN_PARENT, year: 2026, release: "Bowman Chrome" },
      gradeUsed: "Raw",
      daysSinceNewestComp: 2,
      variantWarning: [],
      effectiveFmv: 250,
      predictedPrice: 245,
      predictedPriceRange: { low: 220, high: 270 },
      predictedPriceAttribution: { mechanism: "trendiq-projection" },
      signalsLastUpdated: "2026-06-26T15:30:00.000Z",
    })),
  };
});

let app: any;

beforeAll(async () => {
  app = (await import("../src/app")).default;
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("network disabled in tests")),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(): Promise<{ sessionId: string; userId: string }> {
  const res = await request(app)
    .post("/api/auth/signin")
    .send({ username: "HobbyIQ", password: "Baseball25" });
  expect(res.status).toBe(200);
  return {
    sessionId: res.body.sessionId as string,
    userId: res.body.user?.userId as string,
  };
}

async function seedHolding(
  userId: string,
  holdingId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const doc = await readUserDoc(userId);
  doc.holdings[holdingId] = {
    id: holdingId,
    quantity: 1,
    purchasePrice: 250,
    totalCostBasis: 250,
    cardStatus: "active",
    ...fields,
  } as any;
  await writeUserDoc(userId, doc);
}

describe("repriceHoldingsForUser — parallelId threaded into computeEstimate (CF-HOLDING-REFRESH-PARALLELID-THREAD)", () => {
  it("PARALLEL holding: /reprice/batch passes parallelId to computeEstimate (the line CF-ENGINE-PARALLEL-CANONICALIZE needs)", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = `hartman-greenshimmer-${Date.now()}`;

    await seedHolding(userId, holdingId, {
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Green Shimmer Refractor /99",
      isAuto: true,
      cardId: HARTMAN_PARENT,
      parallelId: GREEN_SHIMMER_PARALLEL_ID,
      lastUpdated: "2026-06-17T00:00:00.000Z",
    });

    const compiqEstimateService = await import(
      "../src/services/compiq/compiqEstimate.service.js",
    );
    const mockFn = compiqEstimateService.computeEstimate as unknown as ReturnType<typeof vi.fn>;
    mockFn.mockClear();

    const r = await request(app)
      .post("/api/portfolio/reprice/batch")
      .set("x-session-id", sessionId)
      .send({});
    expect(r.status).toBe(200);

    const calls = mockFn.mock.calls.filter(
      (call: any[]) => call[1]?.holdingId === holdingId,
    );
    expect(
      calls.length,
      `reprice did not call computeEstimate for ${holdingId}`,
    ).toBeGreaterThan(0);

    const [body] = calls[0];
    expect(body.parallelId).toBe(GREEN_SHIMMER_PARALLEL_ID);
    expect(body.cardId).toBe(HARTMAN_PARENT);
    expect(body.parallel).toBe("Green Shimmer Refractor /99");
    expect(body.pinnedAuthoritative).toBe(true);
  });

  it("BASE-only holding (no parallelId): body.parallelId is undefined (back-compat)", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = `trout-base-${Date.now()}`;

    await seedHolding(userId, holdingId, {
      playerName: "Mike Trout",
      cardYear: 2011,
      product: "Topps Update",
      cardId: "fda530ab-e925-460e-ab88-63199ef975e9",
      lastUpdated: "2026-06-17T00:00:00.000Z",
    });

    const compiqEstimateService = await import(
      "../src/services/compiq/compiqEstimate.service.js",
    );
    const mockFn = compiqEstimateService.computeEstimate as unknown as ReturnType<typeof vi.fn>;
    mockFn.mockClear();

    const r = await request(app)
      .post("/api/portfolio/reprice/batch")
      .set("x-session-id", sessionId)
      .send({});
    expect(r.status).toBe(200);

    const calls = mockFn.mock.calls.filter(
      (call: any[]) => call[1]?.holdingId === holdingId,
    );
    expect(calls.length).toBeGreaterThan(0);
    const [body] = calls[0];
    expect(body.parallelId).toBeUndefined();
  });
});

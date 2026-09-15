/**
 * CF-A-PRICE-REQUEST-HAS-A-DEADLINE / CF-ONE-CANONICAL-WALK-PER-REQUEST
 * (Fable, 2026-09-15).
 *
 * THE INCIDENT. The deploy smoke's "parallel-floor → withheld" case — "2026
 * Bowman Chrome Owen Carey Black BCP-69" — hit its new 60 s client deadline at
 * 60,002 ms. That case's CORRECT answer is a refusal: a 2026 /10 parallel whose
 * pool holds zero sold_comps, so every rung must miss before anything can be
 * said. Taking a minute to say "no" is the worst of both worlds.
 *
 * Two defects, both pinned here.
 *
 *   1. /price had no ceiling of its own. The individual pieces are bounded —
 *      LadderBudget at 8 s, the CH client at 20 s per call, the catalog lookup
 *      by #2163 — but nothing bounded their SUM, so the only thing that ever
 *      stopped a slow request was Azure's 240 s front-end kill, which reaches
 *      the client as an opaque HTTP 499.
 *
 *   2. The canonical ladder was walked TWICE for the same card. The
 *      canonical-first block walks it and, when it refuses, does not return;
 *      the canonical-FMV fallback block then walks all eleven rungs again to be
 *      told the same thing — doubling the slowest work in the request precisely
 *      on the queries that are already slowest.
 *
 * The refusal shape is the one smoke-test-pricing-tiers.withheldReasonOf
 * already reads, carrying `ladder-timeout` from the vocabulary
 * oneValuationPath.ValuationReason already defines. So a slow request degrades
 * to a REASONED null — a product decision — and never trips engine_ok, which
 * gates the nightly reprice.
 */
import request from "supertest";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

process.env.COMPIQ_CORPUS_DISABLED = "1";

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => ({
      userId: "test-user", email: "t@t", username: null, fullName: null,
      plan: "pro_seller", createdAt: "2026-01-01T00:00:00Z",
    })),
  };
});

/** The one valuation path — the walk we are counting. */
const valueIdentity = vi.fn();
vi.mock("../src/services/compiq/oneValuationPath.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, valueIdentity };
});

/** The SECOND walk. Any call to this is a walk that should not have happened. */
const computeCanonicalValuation = vi.fn();
vi.mock("../src/services/compiq/canonicalValuation.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, computeCanonicalValuation };
});

/** Resolves the query to a catalog slug, so walk 1 is reached at all. */
const SLUG = "hiq:baseball:2026:bowman-chrome:bcp-69:black:no-auto";
vi.mock("../src/services/compiq/searchIdentityResolver.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    resolveSearchIdentity: vi.fn(async () => ({
      slug: SLUG, parallel: "Black", cardNumber: "BCP-69", sport: "baseball",
    })),
  };
});

const computeEstimate = vi.fn();
vi.mock("../src/services/compiq/compiqEstimate.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, computeEstimate };
});

let app: any;
beforeAll(async () => { app = (await import("../src/app")).default; });

/** A refusal from the one path: null FMV carrying a named reason. */
const WITHHELD_WALK = {
  fairMarketValue: null,
  compsUsed: 0,
  reason: "no-exact-pool",
  rungLabel: "no-basis",
  basis: "No sale of this identity in 180 days at any grade.",
  confidence: 0,
  sales: [],
  identity: { sport: "baseball", slug: SLUG },
};

/** computeEstimate's "couldn't price it" shape, which sends the request into
 *  the canonical-FMV fallback block where the second walk used to live. */
const THIN_ESTIMATE = {
  fairMarketValue: 0, source: "no-recent-comps", compsUsed: 0, compsAvailable: 0,
  recentComps: [], cardIdentity: { card_id: SLUG, player: "Owen Carey", year: 2026 },
  confidence: { pricingConfidence: 0 }, verdict: "No recent comps.",
};

beforeEach(() => {
  vi.clearAllMocks();
  valueIdentity.mockResolvedValue(WITHHELD_WALK);
  computeEstimate.mockResolvedValue(THIN_ESTIMATE);
  computeCanonicalValuation.mockResolvedValue({
    fmv: null, method: "no-basis", confidence: 0, fmvReason: "no-exact-pool", provenance: null,
  });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});
afterEach(() => { vi.unstubAllGlobals(); });

/** The smoke case, suffixed per test because /price is response-cached. */
const post = (n: number) =>
  request(app).post("/api/compiq/price")
    .set("x-session-id", "test-session")
    .send({ query: `202${n} Bowman Chrome Owen Carey Black BCP-69` });

describe("a slow request is answered, not hung", () => {
  it("returns the withheld shape with a visible reason instead of hanging", async () => {
    // A dependency that never settles — the shape of the 60,002 ms case.
    valueIdentity.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();

    const pending = post(0);
    await vi.advanceTimersByTimeAsync(26_000);
    vi.useRealTimers();
    const res = await pending;

    expect(res.status).toBe(200);
    expect(res.body.fairMarketValue).toBeNull();
    // Null PLUS a reason is the withheld contract. A bare null is the outage
    // shape, and the smoke stops the nightly reprice on that.
    expect(res.body.canonicalFmvWithheld?.reason).toBe("ladder-timeout");
    expect(res.body.fmvReason).toBe("ladder-timeout");
    expect(typeof res.body.verdict).toBe("string");
    expect(res.body.verdict.length).toBeGreaterThan(0);
  }, 30_000);

  it("never answers with a fabricated number", async () => {
    valueIdentity.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const pending = post(1);
    await vi.advanceTimersByTimeAsync(26_000);
    vi.useRealTimers();
    const res = await pending;

    // Doctrine: a withheld price is null and a reason — never a slow number,
    // and never one invented so the request could answer within budget.
    for (const field of ["fairMarketValue", "marketValue", "predictedPrice", "fairMarketValueLive"]) {
      expect(res.body[field]).toBeNull();
    }
    expect(res.body.compsUsed).toBe(0);
  }, 30_000);

  it("a fast request is untouched by the deadline", async () => {
    valueIdentity.mockResolvedValue({
      ...WITHHELD_WALK, fairMarketValue: 425, compsUsed: 7, reason: null,
      rungLabel: "direct-slug", basis: "Priced from the exact-identity pool.",
    });

    const res = await post(2);

    // MUTATION CHECK: the ceiling is a last line of defence. If it fired on a
    // healthy request it would be turning good answers into refusals.
    expect(res.status).toBe(200);
    expect(res.body.fairMarketValue).toBe(425);
    expect(res.body.canonicalFmvWithheld?.reason).not.toBe("ladder-timeout");
  });
});

describe("the canonical ladder is walked once per request", () => {
  it("reuses walk 1's refusal instead of walking the ladder again", async () => {
    const res = await post(3);

    // Walk 1 ran.
    expect(valueIdentity).toHaveBeenCalledTimes(1);
    // MUTATION CHECK: pre-fix this was 1 — the same eleven rungs, for the same
    // card, at the same instant, to be told the same thing. On an empty-pool
    // card that is the difference between one full ladder walk and two.
    expect(computeCanonicalValuation).not.toHaveBeenCalled();

    // And the refusal still reaches the wire, carrying walk 1's own reason.
    expect(res.body.canonicalFmvWithheld?.reason).toBe("no-exact-pool");
  });

  it("still asks the engine when the fallback is about a DIFFERENT card", async () => {
    // computeEstimate can resolve a different identity than the one walk 1
    // asked about — and the AI-matcher retry can replace it outright.
    computeEstimate.mockResolvedValue({
      ...THIN_ESTIMATE,
      cardIdentity: { card_id: "hiq:baseball:2026:bowman-chrome:bcp-70:base:no-auto", player: "Someone Else" },
    });

    await post(4);

    // MUTATION CHECK: reusing a verdict across two different identities would
    // answer a question the engine was never asked — a wrong refusal attributed
    // to the wrong card. The id check is what makes the reuse safe.
    expect(computeCanonicalValuation).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a walk that PUBLISHED a number", async () => {
    // A walk that published returns from the first block and cannot reach the
    // fallback. This pins that the reuse is gated on the refusal, not merely on
    // a walk having happened — so a published number can never be replayed as
    // a refusal.
    valueIdentity.mockResolvedValue({
      ...WITHHELD_WALK, fairMarketValue: 900, compsUsed: 4, reason: null, rungLabel: "direct-slug",
    });

    const res = await post(5);

    expect(res.body.fairMarketValue).toBe(900);
    expect(res.body.canonicalFmvWithheld).toBeFalsy();
  });
});

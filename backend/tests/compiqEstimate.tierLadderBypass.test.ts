// CF-VARIANT-FILTER-BACKTEST — tier-ladder bypass coverage.
//
// Verifies the two bypass surfaces and their restriction semantics:
//   1. VARIANT_TIER_LADDER_ENABLED=false env flag → globally bypasses ladder
//   2. `x-variant-tier-ladder: disabled` header → per-request bypass, ONLY
//      honored when (NODE_ENV !== "production") OR session resolves to
//      admin-testing-hobbyiq
//
// Bypass semantics: tier ladder skipped; computeEstimate runs T0-only.
// If T0 yields <3 surviving comps AND the request had variant attributes,
// the response is source=variant-mismatch (legacy pre-ladder behavior).
//
// This isolates the "tier-ladder enabled vs disabled" arms for paired
// backtest measurement (the existing signal-value harness measures a
// different axis — signal-on vs signal-off through OpenAI inference).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  getCardSales: vi.fn(),
  searchCards: vi.fn(),
  findCompsByQuery: vi.fn(),
}));

import app from "../src/app";
import * as cardHedge from "../src/services/compiq/cardhedge.client.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function signIn(username: string, password: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signin")
    .send({ username, password });
  expect(res.status).toBe(200);
  return res.body.sessionId as string;
}

// Canonical "tier ladder fires legitimately" fixture: Drake Baldwin Blue
// Refractor Auto. With ladder ENABLED this case promotes to T1 (drops
// parallel filter, prices from the broader player+auto pool). With
// ladder DISABLED, the strict T0 yields 0 → variant-mismatch.
function mockDrakeBaldwinT1Fixture() {
  const now = Date.now();
  const isoDaysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
  (cardHedge.findCompsByQuery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    card: {
      card_id: "card-drake-blue-auto-150",
      title: "2022 Bowman Chrome Drake Baldwin Blue Refractor Auto /150",
      player: "Drake Baldwin",
      set: "Bowman Chrome",
      year: 2022,
      number: "CPA-DBN",
      variant: "Blue Refractor Auto /150",
    },
    sales: [
      { price: 145, date: isoDaysAgo(8), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
      { price: 150, date: isoDaysAgo(11), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
      { price: 155, date: isoDaysAgo(16), title: "2022 Bowman Draft CDA-DBN Drake Baldwin Refractor Auto /499" },
    ],
    variantWarning: ["auto_mismatch"],
    aiCategory: "Baseball",
  });
}

const DRAKE_BODY = {
  playerName: "Drake Baldwin",
  cardYear: 2022,
  product: "Bowman Chrome",
  parallel: "Blue Refractor",
  isAuto: true,
};

describe("CF-VARIANT-FILTER-BACKTEST — env flag (VARIANT_TIER_LADDER_ENABLED)", () => {
  it("env unset → tier ladder enabled (default behavior, T1 promotion)", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
    mockDrakeBaldwinT1Fixture();

    const res = await request(app).post("/api/compiq/estimate").send(DRAKE_BODY);

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("live");
    expect(res.body.compQuality?.variantStrictness).toBe("T1");
    expect(typeof res.body.marketValue).toBe("number");
  });

  it("VARIANT_TIER_LADDER_ENABLED=false → tier ladder bypassed (variant-mismatch)", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
    vi.stubEnv("VARIANT_TIER_LADDER_ENABLED", "false");
    mockDrakeBaldwinT1Fixture();

    const res = await request(app).post("/api/compiq/estimate").send(DRAKE_BODY);

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("variant-mismatch");
    expect(res.body.marketValue).toBeNull();
    // tier metadata still surfaced; trace shows T0 had 0 matches and ladder
    // never escalated (T1/T2/T3 zeros).
    expect(res.body.compQuality?.variantStrictness).toBe("T0");
    expect(res.body.compQuality?.tierLadderTrace).toEqual({ T0: 0, T1: 0, T2: 0, T3: 0 });
  });

  it("VARIANT_TIER_LADDER_ENABLED=true (explicit) → ladder enabled (same as default)", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
    vi.stubEnv("VARIANT_TIER_LADDER_ENABLED", "true");
    mockDrakeBaldwinT1Fixture();

    const res = await request(app).post("/api/compiq/estimate").send(DRAKE_BODY);
    expect(res.body.source).toBe("live");
    expect(res.body.compQuality?.variantStrictness).toBe("T1");
  });
});

describe("CF-VARIANT-FILTER-BACKTEST — restricted header override", () => {
  it("header without restriction context → ignored (production env, no session)", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
    vi.stubEnv("NODE_ENV", "production");
    mockDrakeBaldwinT1Fixture();

    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-variant-tier-ladder", "disabled")
      .send(DRAKE_BODY);

    // Header silently ignored; ladder still enabled; T1 rescue fires.
    expect(res.body.source).toBe("live");
    expect(res.body.compQuality?.variantStrictness).toBe("T1");
  });

  it("header honored when NODE_ENV !== production (default test env)", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
    // NODE_ENV may be "test" or undefined — both count as non-production.
    vi.stubEnv("NODE_ENV", "test");
    mockDrakeBaldwinT1Fixture();

    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-variant-tier-ladder", "disabled")
      .send(DRAKE_BODY);

    expect(res.body.source).toBe("variant-mismatch");
    expect(res.body.compQuality?.variantStrictness).toBe("T0");
  });

  it("header honored in production when session resolves to admin-testing-hobbyiq", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
    vi.stubEnv("NODE_ENV", "production");
    const session = await signIn("HobbyIQ", "Baseball25");
    mockDrakeBaldwinT1Fixture();

    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-variant-tier-ladder", "disabled")
      .set("x-session-id", session)
      .send(DRAKE_BODY);

    expect(res.body.source).toBe("variant-mismatch");
  });

  it("header rejected in production when session is a non-admin user", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
    vi.stubEnv("NODE_ENV", "production");
    const session = await signIn("JusttheBoysandCards", "Carolina23");
    mockDrakeBaldwinT1Fixture();

    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-variant-tier-ladder", "disabled")
      .set("x-session-id", session)
      .send(DRAKE_BODY);

    // Header silently ignored for non-admin in production.
    expect(res.body.source).toBe("live");
    expect(res.body.compQuality?.variantStrictness).toBe("T1");
  });

  it("header value other than \"disabled\" is ignored", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
    mockDrakeBaldwinT1Fixture();

    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-variant-tier-ladder", "enabled") // not the magic value
      .send(DRAKE_BODY);

    expect(res.body.source).toBe("live");
    expect(res.body.compQuality?.variantStrictness).toBe("T1");
  });

  it("env-flag-false + header honored: both paths produce identical bypass (idempotent)", async () => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
    vi.stubEnv("VARIANT_TIER_LADDER_ENABLED", "false");
    vi.stubEnv("NODE_ENV", "test");
    mockDrakeBaldwinT1Fixture();

    const res = await request(app)
      .post("/api/compiq/estimate")
      .set("x-variant-tier-ladder", "disabled")
      .send(DRAKE_BODY);

    expect(res.body.source).toBe("variant-mismatch");
  });
});

// CF-ADVANCED-ALERTS (2026-06-03): orchestrator coverage.
//
// Validates:
//  - resolveTargets fans out per scope type (card/player/watchlist/holdings)
//  - per-rule target cap overflow + structured log
//  - cooldownActive gate
//  - sliceEstimate extracts fmv/predicted/confidence/trendIQ correctly
//  - per-pass dedup so two rules pointing to the same card fetch once
//  - APNs fires via sendAdvancedAlertNotification with data.type="advanced_alert"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";

// Mocks must be hoisted before importing the orchestrator.
const computeEstimateMock = vi.fn();
vi.mock("../src/services/compiq/compiqEstimate.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    computeEstimate: (...args: unknown[]) => computeEstimateMock(...args),
  };
});

const sendAdvancedAlertMock = vi.fn(async () => ({
  sent: 1,
  failed: 0,
  removedTokens: 0,
}));
vi.mock("../src/services/notification.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    sendAdvancedAlertNotification: (...args: unknown[]) =>
      sendAdvancedAlertMock(...args),
  };
});

const watchlistMock = vi.fn(async () => [] as any[]);
vi.mock("../src/services/dailyiq/watchlistStore.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getWatchlistEntries: (...args: unknown[]) => watchlistMock(...args),
  };
});

const portfolioMock = vi.fn(async () => ({
  id: "u",
  userId: "u",
  holdings: {} as Record<string, any>,
  ledger: [],
  priceHistoryByHolding: {},
  alerts: [],
  recommendationFeedback: [],
}));
vi.mock("../src/services/portfolioiq/portfolioStore.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    readUserDoc: (...args: unknown[]) => portfolioMock(...args),
  };
});

const listActiveRulesMock = vi.fn(async () => [] as any[]);
const recordEvalMock = vi.fn(async () => null);
vi.mock("../src/repositories/advancedAlertRules.repository.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    listAllActiveRules: (...args: unknown[]) => listActiveRulesMock(...args),
    recordRuleEvaluation: (...args: unknown[]) => recordEvalMock(...args),
  };
});

import {
  cooldownActive,
  resolveTargets,
  runAdvancedAlertsEvaluator,
  sliceEstimate,
  startAdvancedAlertsEvaluatorJob,
  stopAdvancedAlertsEvaluatorJob,
  __resetAdvancedAlertEvaluatorForTests,
} from "../src/services/advancedAlerts/ruleEvaluator.js";
import type { AdvancedAlertRule } from "../src/repositories/advancedAlertRules.repository.js";

function makeRule(overrides: Partial<AdvancedAlertRule> = {}): AdvancedAlertRule {
  return {
    ruleId: "r-1",
    userId: "u-1",
    name: "Test rule",
    scope: { type: "card", cardId: "c-1" },
    combinator: "AND",
    conditions: [{ kind: "predicted_direction", equals: "up" }],
    cooldownMin: 360,
    isActive: true,
    createdAt: "2026-01-01T00:00:00Z",
    lastEvaluatedAt: null,
    lastTriggeredAt: null,
    triggerCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  computeEstimateMock.mockReset();
  sendAdvancedAlertMock.mockClear();
  watchlistMock.mockReset().mockResolvedValue([]);
  portfolioMock.mockReset().mockResolvedValue({
    id: "u",
    userId: "u",
    holdings: {},
    ledger: [],
    priceHistoryByHolding: {},
    alerts: [],
    recommendationFeedback: [],
  });
  listActiveRulesMock.mockReset().mockResolvedValue([]);
  recordEvalMock.mockReset().mockResolvedValue(null);
  __resetAdvancedAlertEvaluatorForTests();
  delete process.env.ADVANCED_ALERT_TARGETS_PER_RULE_MAX;
});

afterEach(() => {
  delete process.env.ADVANCED_ALERT_TARGETS_PER_RULE_MAX;
});

// ─── sliceEstimate ──────────────────────────────────────────────────────────

describe("sliceEstimate", () => {
  it("extracts fmv, predicted, confidence (nested), trendIQ", () => {
    const slice = sliceEstimate({
      fairMarketValue: 120,
      predictedPrice: 135,
      confidence: { pricingConfidence: 78, liquidityConfidence: 0, timingConfidence: 0 },
      trendIQ: { composite: 1.18, direction: "up", coverage: "full" },
    });
    expect(slice).toEqual({
      fairMarketValue: 120,
      predictedPrice: 135,
      pricingConfidence: 78,
      trendIQ: { composite: 1.18, direction: "up", coverage: "full" },
    });
  });
  it("handles missing fields with nulls", () => {
    const slice = sliceEstimate({});
    expect(slice).toEqual({
      fairMarketValue: null,
      predictedPrice: null,
      pricingConfidence: null,
      trendIQ: null,
    });
  });
});

// ─── cooldownActive ─────────────────────────────────────────────────────────

describe("cooldownActive", () => {
  const now = Date.parse("2026-06-03T12:00:00.000Z");
  it("returns false when lastTriggeredAt is null", () => {
    expect(cooldownActive(makeRule({ lastTriggeredAt: null }), now)).toBe(false);
  });
  it("returns true when within cooldown window", () => {
    const justFired = new Date(now - 30 * 60 * 1000).toISOString(); // 30 min ago
    expect(
      cooldownActive(makeRule({ lastTriggeredAt: justFired, cooldownMin: 360 }), now),
    ).toBe(true);
  });
  it("returns false when cooldown has elapsed", () => {
    const longAgo = new Date(now - 10 * 60 * 60 * 1000).toISOString(); // 10h ago
    expect(
      cooldownActive(makeRule({ lastTriggeredAt: longAgo, cooldownMin: 360 }), now),
    ).toBe(false);
  });
});

// ─── resolveTargets ─────────────────────────────────────────────────────────

describe("resolveTargets — fan-out per scope", () => {
  it("scope=card resolves to one target with cardId pinned", async () => {
    const r = await resolveTargets(
      makeRule({
        scope: { type: "card", cardId: "c-abc", gradeCompany: "PSA", gradeValue: 10 },
      }),
    );
    expect(r.targets.length).toBe(1);
    expect(r.targets[0].request.cardId).toBe("c-abc");
    expect(r.targets[0].request.gradeCompany).toBe("PSA");
    expect(r.targets[0].holdingId).toBeNull();
    expect(r.overflow).toBe(false);
  });

  it("scope=player resolves to one target with no cardId pin", async () => {
    const r = await resolveTargets(
      makeRule({ scope: { type: "player", playerName: "Paul Skenes" } }),
    );
    expect(r.targets.length).toBe(1);
    expect(r.targets[0].request.playerName).toBe("Paul Skenes");
    expect(r.targets[0].request.cardId).toBeUndefined();
  });

  it("scope=watchlist fans out to one target per watchlist entry", async () => {
    watchlistMock.mockResolvedValueOnce([
      { watchlistItemId: "w1", userId: "u-1", playerId: "p1", playerName: "Skenes", createdAt: "" },
      { watchlistItemId: "w2", userId: "u-1", playerId: "p2", playerName: "Acuna", createdAt: "" },
    ] as any);
    const r = await resolveTargets(makeRule({ scope: { type: "watchlist" } }));
    expect(r.targets.length).toBe(2);
    expect(r.targets.map((t) => t.request.playerName).sort()).toEqual(["Acuna", "Skenes"]);
  });

  it("scope=holdings fans out to one target per holding with grade extraction", async () => {
    portfolioMock.mockResolvedValueOnce({
      id: "u-1",
      userId: "u-1",
      holdings: {
        h1: { id: "h1", playerName: "Skenes", gradeCompany: "PSA", gradeValue: 10 },
        h2: { id: "h2", playerName: "Acuna", gradeCompany: "BGS", gradeValue: 9.5 },
      } as any,
      ledger: [],
      priceHistoryByHolding: {},
      alerts: [],
      recommendationFeedback: [],
    });
    const r = await resolveTargets(makeRule({ scope: { type: "holdings" } }));
    expect(r.targets.length).toBe(2);
    expect(r.targets[0].holdingId).toBe("h1");
    expect(r.targets[1].holdingId).toBe("h2");
  });

  it("per-rule target cap truncates + logs overflow", async () => {
    process.env.ADVANCED_ALERT_TARGETS_PER_RULE_MAX = "3";
    portfolioMock.mockResolvedValueOnce({
      id: "u-1",
      userId: "u-1",
      holdings: Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`h${i}`, { id: `h${i}`, playerName: `P${i}` }]),
      ) as any,
      ledger: [],
      priceHistoryByHolding: {},
      alerts: [],
      recommendationFeedback: [],
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await resolveTargets(makeRule({ scope: { type: "holdings" } }));
    expect(r.targets.length).toBe(3);
    expect(r.overflow).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/rule overflow/);
    warnSpy.mockRestore();
  });

  // ── CF-HOLDING-ESTIMATE-INPUT-CONSOLIDATION (2026-06-18) ────────────────
  // The four cases below pin the canonical-shape adoption at site 3
  // (advancedAlerts.targetFromHolding) — the SEVEN drift corrections the
  // alert site adopts when routing through buildEstimateRequestFromHolding.
  // See the helper's doc comment in portfolioStore.service.ts for the full
  // drift inventory.

  it("CF-CONSOLIDATION: pinned holding with sparse identity carries cardId + pinnedAuthoritative=true (drift correction #7 — the explicit CF goal)", async () => {
    // The Drew-Trout shape: cardId stored, identity fields sparse.
    portfolioMock.mockResolvedValueOnce({
      id: "u-1", userId: "u-1",
      holdings: {
        h1: {
          id: "h1",
          playerName: "Mike Trout",
          cardId: "fda530ab-e925-460e-ab88-63199ef975e9",
          // intentionally NO cardYear/product/parallel/grade — sparse identity
        },
      } as any,
      ledger: [], priceHistoryByHolding: {}, alerts: [], recommendationFeedback: [],
    });
    const r = await resolveTargets(makeRule({ scope: { type: "holdings" } }));
    expect(r.targets.length).toBe(1);
    const req = r.targets[0].request;
    expect(req.cardId).toBe("fda530ab-e925-460e-ab88-63199ef975e9");
    expect(req.pinnedAuthoritative).toBe(true);
    // playerName preserved REAL — no UUID overload, corpus-clean rule.
    expect(req.playerName).toBe("Mike Trout");
  });

  it("CF-CONSOLIDATION: unpinned holding (no cardId) → cardId undefined + pinnedAuthoritative=false (default-off invariant)", async () => {
    portfolioMock.mockResolvedValueOnce({
      id: "u-1", userId: "u-1",
      holdings: {
        h1: {
          id: "h1",
          playerName: "Paul Skenes",
          cardYear: 2024,
          product: "Topps Chrome",
          // no cardId
        },
      } as any,
      ledger: [], priceHistoryByHolding: {}, alerts: [], recommendationFeedback: [],
    });
    const r = await resolveTargets(makeRule({ scope: { type: "holdings" } }));
    expect(r.targets.length).toBe(1);
    const req = r.targets[0].request;
    expect(req.cardId).toBeUndefined();
    expect(req.pinnedAuthoritative).toBe(false);
    expect(req.playerName).toBe("Paul Skenes");
    expect(req.cardYear).toBe(2024);
    expect(req.product).toBe("Topps Chrome");
  });

  it("CF-CONSOLIDATION: isAuto holding declares isAuto=true (drift correction #4 — the only behaviorally meaningful drift)", async () => {
    // Pre-consolidation: site 3 OMITTED isAuto, so the engine's variant-
    // ladder auto-exclusion never fired for alert evaluations — auto
    // holdings mixed with non-auto comps. Post-consolidation: the request
    // declares isAuto and the engine's auto-comp filter kicks in.
    portfolioMock.mockResolvedValueOnce({
      id: "u-1", userId: "u-1",
      holdings: {
        h1: {
          id: "h1",
          playerName: "Eric Hartman",
          cardYear: 2026,
          product: "Bowman Chrome",
          isAuto: true,
        },
      } as any,
      ledger: [], priceHistoryByHolding: {}, alerts: [], recommendationFeedback: [],
    });
    const r = await resolveTargets(makeRule({ scope: { type: "holdings" } }));
    const req = r.targets[0].request;
    expect(req.isAuto).toBe(true);
  });

  it("CF-CONSOLIDATION: legacy field shapes get shim corrections (drifts #1, #2, #5, #6)", async () => {
    // Legacy holding with:
    //   - `year` (string) instead of `cardYear` (number)   → drift #1: shimmedCardYear's `year` fallback + 0-coerce
    //   - `setName` populated, no `product`               → drift #2: shimmedProduct falls back to setName, trimmed
    //   - `gradingCompany` (legacy), no `gradeCompany`    → drift #5: fallback prefers gradingCompany
    //   - `gradeValue` as a numeric string                → drift #6: toNumber coercion
    portfolioMock.mockResolvedValueOnce({
      id: "u-1", userId: "u-1",
      holdings: {
        h1: {
          id: "h1",
          playerName: "Bobby Witt Jr",
          year: "2020",                          // legacy string year
          setName: "  Bowman Chrome  ",          // padded, no canonical product
          gradingCompany: "PSA",                 // legacy field
          gradeValue: "10" as any,               // stringified grade
        },
      } as any,
      ledger: [], priceHistoryByHolding: {}, alerts: [], recommendationFeedback: [],
    });
    const r = await resolveTargets(makeRule({ scope: { type: "holdings" } }));
    const req = r.targets[0].request;
    expect(req.cardYear).toBe(2020);                  // drift #1: shimmed from legacy `year`
    expect(req.product).toBe("Bowman Chrome");        // drift #2: shimmed from setName + trimmed
    expect(req.gradeCompany).toBe("PSA");             // drift #5: shimmed from gradingCompany
    expect(req.gradeValue).toBe(10);                  // drift #6: coerced "10" → 10
  });
});

// ─── runAdvancedAlertsEvaluator ─────────────────────────────────────────────

describe("runAdvancedAlertsEvaluator — pass-level orchestration", () => {
  it("fires APNs with data.type=advanced_alert on rule match", async () => {
    listActiveRulesMock.mockResolvedValueOnce([
      makeRule({
        scope: { type: "card", cardId: "c-1" },
        combinator: "AND",
        conditions: [{ kind: "predicted_direction", equals: "up" }],
      }),
    ]);
    computeEstimateMock.mockResolvedValueOnce({
      fairMarketValue: 100,
      predictedPrice: 110,
      confidence: { pricingConfidence: 75 },
      trendIQ: { composite: 1.2, direction: "up", coverage: "full" },
    });

    const summary = await runAdvancedAlertsEvaluator();

    expect(summary.rulesEvaluated).toBe(1);
    expect(summary.rulesTriggered).toBe(1);
    expect(sendAdvancedAlertMock).toHaveBeenCalledTimes(1);
    const pushArg = sendAdvancedAlertMock.mock.calls[0][1] as any;
    expect(pushArg.ruleId).toBe("r-1");
    expect(pushArg.scopeType).toBe("card");
    expect(pushArg.cardId).toBe("c-1");
  });

  it("skips fire when cooldown is active", async () => {
    const now = Date.now();
    listActiveRulesMock.mockResolvedValueOnce([
      makeRule({
        lastTriggeredAt: new Date(now - 15 * 60 * 1000).toISOString(),
        cooldownMin: 360,
      }),
    ]);
    const summary = await runAdvancedAlertsEvaluator();
    expect(summary.cooldownSkipped).toBe(1);
    expect(summary.rulesTriggered).toBe(0);
    expect(sendAdvancedAlertMock).not.toHaveBeenCalled();
    expect(computeEstimateMock).not.toHaveBeenCalled();
  });

  it("does not fire when conditions do not match", async () => {
    listActiveRulesMock.mockResolvedValueOnce([
      makeRule({
        conditions: [{ kind: "predicted_direction", equals: "up" }],
      }),
    ]);
    computeEstimateMock.mockResolvedValueOnce({
      fairMarketValue: 100,
      predictedPrice: 95,
      confidence: { pricingConfidence: 80 },
      trendIQ: { composite: 0.95, direction: "down", coverage: "full" },
    });
    const summary = await runAdvancedAlertsEvaluator();
    expect(summary.rulesTriggered).toBe(0);
    expect(summary.estimatesFetched).toBe(1);
    expect(sendAdvancedAlertMock).not.toHaveBeenCalled();
  });

  it("dedups identical targets across rules within one pass", async () => {
    listActiveRulesMock.mockResolvedValueOnce([
      makeRule({ ruleId: "r-A", scope: { type: "card", cardId: "shared" } }),
      makeRule({ ruleId: "r-B", scope: { type: "card", cardId: "shared" } }),
    ]);
    computeEstimateMock.mockResolvedValue({
      fairMarketValue: 100,
      predictedPrice: 105,
      confidence: { pricingConfidence: 70 },
      trendIQ: { composite: 1.1, direction: "up", coverage: "full" },
    });
    const summary = await runAdvancedAlertsEvaluator();
    expect(computeEstimateMock).toHaveBeenCalledTimes(1);
    expect(summary.estimatesFetched).toBe(1);
    expect(summary.estimatesCached).toBe(1);
  });
});

// ─── Cadence (FIX 1, 2026-06-03) ────────────────────────────────────────────
//
// Advanced rules now run on their OWN timer at default 4h cadence — NOT the
// basic-price 30-min cycle. Lock the env wiring + kill switch behavior.

describe("startAdvancedAlertsEvaluatorJob — cadence wiring", () => {
  beforeEach(() => {
    stopAdvancedAlertsEvaluatorJob();
    delete process.env.ADVANCED_ALERTS_EVALUATOR_DISABLE;
    delete process.env.ADVANCED_ALERTS_EVALUATOR_INTERVAL_MIN;
    delete process.env.ADVANCED_ALERTS_EVALUATOR_FIRST_DELAY_MS;
  });
  afterEach(() => {
    stopAdvancedAlertsEvaluatorJob();
    delete process.env.ADVANCED_ALERTS_EVALUATOR_DISABLE;
    delete process.env.ADVANCED_ALERTS_EVALUATOR_INTERVAL_MIN;
    delete process.env.ADVANCED_ALERTS_EVALUATOR_FIRST_DELAY_MS;
  });

  it("kill switch ADVANCED_ALERTS_EVALUATOR_DISABLE=true → no timer scheduled", () => {
    process.env.ADVANCED_ALERTS_EVALUATOR_DISABLE = "true";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    startAdvancedAlertsEvaluatorJob();
    const messages = logSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("disabled via ADVANCED_ALERTS_EVALUATOR_DISABLE"))).toBe(true);
    expect(messages.some((m) => m.includes("scheduling first run"))).toBe(false);
    logSpy.mockRestore();
  });

  it("default interval is 240 min (4h)", () => {
    process.env.ADVANCED_ALERTS_EVALUATOR_FIRST_DELAY_MS = "60000"; // 60s so it never fires in this test
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    startAdvancedAlertsEvaluatorJob();
    const msg = logSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes("scheduling first run"));
    expect(msg).toBeDefined();
    expect(msg).toMatch(/every 240\.0min/);
    logSpy.mockRestore();
  });

  it("respects ADVANCED_ALERTS_EVALUATOR_INTERVAL_MIN override", () => {
    process.env.ADVANCED_ALERTS_EVALUATOR_INTERVAL_MIN = "120";
    process.env.ADVANCED_ALERTS_EVALUATOR_FIRST_DELAY_MS = "60000";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    startAdvancedAlertsEvaluatorJob();
    const msg = logSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes("scheduling first run"));
    expect(msg).toMatch(/every 120\.0min/);
    logSpy.mockRestore();
  });

  it("floors interval at 30 min (rejects 1-min override)", () => {
    process.env.ADVANCED_ALERTS_EVALUATOR_INTERVAL_MIN = "1";
    process.env.ADVANCED_ALERTS_EVALUATOR_FIRST_DELAY_MS = "60000";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    startAdvancedAlertsEvaluatorJob();
    const msg = logSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes("scheduling first run"));
    // Falls back to default 240 (NOT the 1 the env requested).
    expect(msg).toMatch(/every 240\.0min/);
    logSpy.mockRestore();
  });

  it("ignores duplicate start", () => {
    process.env.ADVANCED_ALERTS_EVALUATOR_FIRST_DELAY_MS = "60000";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    startAdvancedAlertsEvaluatorJob();
    startAdvancedAlertsEvaluatorJob();
    const warned = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => w.includes("scheduler already running"))).toBe(true);
    warnSpy.mockRestore();
  });
});

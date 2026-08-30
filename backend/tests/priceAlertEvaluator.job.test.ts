// CF-ONE-VALUATION-PATH (D17, 2026-08-30) — the price-alert evaluator prices
// an alert's CARD, not its text.
//
// Before D17 the evaluator built a free-text CompIQ estimate request from the
// alert's snapshot (player / year / product / variant / grade) and fired on
// whatever that search priced. Now the alert's identity is resolved to a
// catalog slug — `alert.cardId` through the one valuation entry, else the
// snapshot's derived slug when the catalog holds exactly one of its forms —
// and priced through valueIdentity: the same number every pricing surface
// serves for that slug + grade. Unresolvable alerts are skipped with a
// counted reason and never priced from text.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PriceAlert } from "../src/repositories/priceAlerts.repository.js";
import type { Valuation } from "../src/services/compiq/oneValuationPath.service.js";

const h = vi.hoisted(() => ({
  listAllActiveAlerts: vi.fn<[], Promise<PriceAlert[]>>(),
  recordAlertEvaluation: vi.fn<[string, string, { currentPrice: number | null; triggered: boolean }], Promise<void>>(),
  sendPriceAlertNotification: vi.fn<[string, { title: string; body: string; cardId: string; alertId: string }], Promise<{ sent: number; failed: number }>>(),
  valueIdentity: vi.fn<[Record<string, unknown>], Promise<Partial<Valuation>>>(),
  catalogSlugIfExists: vi.fn<[string], Promise<string | null>>(),
  computeEstimate: vi.fn(),
}));

vi.mock("../src/repositories/priceAlerts.repository.js", () => ({
  listAllActiveAlerts: (...args: unknown[]) => (h.listAllActiveAlerts as any)(...args),
  recordAlertEvaluation: (...args: unknown[]) => (h.recordAlertEvaluation as any)(...args),
}));
vi.mock("../src/services/notification.service.js", () => ({
  sendPriceAlertNotification: (...args: unknown[]) => (h.sendPriceAlertNotification as any)(...args),
}));
vi.mock("../src/services/compiq/oneValuationPath.service.js", () => ({
  valueIdentity: (...args: unknown[]) => (h.valueIdentity as any)(...args),
}));
vi.mock("../src/services/catalog/catalogMatcher.service.js", () => ({
  catalogSlugIfExists: (...args: unknown[]) => (h.catalogSlugIfExists as any)(...args),
}));
// The sport inference behind the snapshot-derived slug, made deterministic.
vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return { ...actual, inferSportFromContext: vi.fn(() => "baseball") };
});
// The text engine must never be reached from here.
vi.mock("../src/services/compiq/compiqEstimate.service.js", () => ({
  computeEstimate: (...args: unknown[]) => (h.computeEstimate as any)(...args),
}));

// Import the module-under-test AFTER mocks are registered.
const { runPriceAlertEvaluator, snapshotSlugCandidates, parseAlertGrade } = await import(
  "../src/jobs/priceAlertEvaluator.job.js"
);
const { computeHobbyIqCardId } = await import("../src/services/portfolioiq/hobbyIqCardId.service.js");

const SLUG = "hiq:baseball:2011:topps-update:us175:base:no-auto";
const identity = (slug: string | null, reason: Valuation["reason"] = null) => ({
  slug, requestedId: "card-1", pooledAs: slug, pooledVia: slug ? "hobbyiqCardId" : null,
  sport: "baseball", year: 2011, setKey: "topps-update", setName: "2011 Topps Update", cardNumber: "US175",
  parallel: "Base", parallelSlug: "base", isAuto: false, printRun: null, playerName: "Mike Trout", imageUrl: null,
  reason,
});
const priced = (slug: string, fmv: number | null, rung = "exact-pool-projection"): Partial<Valuation> => ({
  fairMarketValue: fmv,
  rungLabel: (fmv === null ? "no-basis" : rung) as Valuation["rungLabel"],
  valueSource: fmv === null ? "unavailable" : "observed",
  reason: fmv === null ? "no-exact-pool" : null,
  requestedTier: "PSA 10",
  identity: identity(slug) as Valuation["identity"],
});
const unresolved = (): Partial<Valuation> => ({
  fairMarketValue: null, rungLabel: "no-basis", valueSource: "unavailable", reason: "no-catalog-identity",
  requestedTier: "PSA 10", identity: identity(null, "no-catalog-identity") as Valuation["identity"],
});

function makeAlert(overrides: Partial<PriceAlert> = {}): PriceAlert {
  return {
    alertId: "alert-1",
    userId: "user-1",
    cardId: "card-1",
    playerName: "Mike Trout",
    targetPrice: 50,
    direction: "above",
    currentPrice: null,
    createdAt: "2026-01-01T00:00:00Z",
    triggeredAt: null,
    isActive: true,
    cardSnapshot: {
      playerName: "Mike Trout",
      year: 2011,
      setName: "Topps Update",
      cardNumber: "US175",
      grade: "PSA 10",
      variant: null,
      printRun: null,
      isRookie: true,
    },
    ...overrides,
  };
}

describe("priceAlertEvaluator — the alert's card through the one valuation path", () => {
  beforeEach(() => {
    h.listAllActiveAlerts.mockReset();
    h.recordAlertEvaluation.mockReset();
    h.sendPriceAlertNotification.mockReset();
    h.valueIdentity.mockReset();
    h.catalogSlugIfExists.mockReset();
    h.computeEstimate.mockReset();
    h.recordAlertEvaluation.mockResolvedValue(undefined);
    h.sendPriceAlertNotification.mockResolvedValue({ sent: 1, failed: 0 });
    h.catalogSlugIfExists.mockResolvedValue(null);
  });

  it("alert.cardId names a catalog identity: priced through valueIdentity for the alert's grade; the threshold crosses; push fires; the text engine is never asked", async () => {
    h.listAllActiveAlerts.mockResolvedValue([makeAlert({ targetPrice: 50, direction: "above" })]);
    h.valueIdentity.mockResolvedValue(priced(SLUG, 60));

    const summary = await runPriceAlertEvaluator();

    expect(h.valueIdentity).toHaveBeenCalledTimes(1);
    expect(h.valueIdentity.mock.calls[0][0]).toEqual({
      id: "card-1", grade: { company: "PSA", value: 10 }, printRun: null, playerName: "Mike Trout",
    });
    expect(h.computeEstimate).not.toHaveBeenCalled();
    expect(h.catalogSlugIfExists).not.toHaveBeenCalled();
    expect(h.recordAlertEvaluation).toHaveBeenCalledWith("user-1", "alert-1", { currentPrice: 60, triggered: true });
    expect(h.sendPriceAlertNotification).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ evaluated: 1, triggered: 1, pricingErrors: 0, pushSent: 1, skippedNoIdentity: 0, unpriced: 0 });
  });

  it("counts pricingErrors and does not flip or push when the entry throws", async () => {
    h.listAllActiveAlerts.mockResolvedValue([makeAlert()]);
    h.valueIdentity.mockRejectedValue(new Error("upstream boom"));

    const summary = await runPriceAlertEvaluator();

    expect(h.recordAlertEvaluation).toHaveBeenCalledWith("user-1", "alert-1", { currentPrice: null, triggered: false });
    expect(h.sendPriceAlertNotification).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ evaluated: 1, triggered: 0, pricingErrors: 1, pushSent: 0 });
  });

  it("identity resolved, no number for the tier (null with a reason): no signal — counted unpriced, no trigger, no push, not an error", async () => {
    h.listAllActiveAlerts.mockResolvedValue([makeAlert()]);
    h.valueIdentity.mockResolvedValue(priced(SLUG, null));

    const summary = await runPriceAlertEvaluator();

    expect(h.recordAlertEvaluation).toHaveBeenCalledWith("user-1", "alert-1", { currentPrice: null, triggered: false });
    expect(h.sendPriceAlertNotification).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ evaluated: 1, triggered: 0, pricingErrors: 0, unpriced: 1, unchanged: 1 });
  });

  it("cardId names no identity: the snapshot derives a slug, adopted only because the catalog holds exactly one form — and THAT slug is priced", async () => {
    const derivedNoAuto = computeHobbyIqCardId({ sport: "baseball", year: 2011, setKey: "Topps Update", cardNumber: "US175", parallel: "Base", isAuto: false, printRun: null });
    const derivedAuto = computeHobbyIqCardId({ sport: "baseball", year: 2011, setKey: "Topps Update", cardNumber: "US175", parallel: "Base", isAuto: true, printRun: null });
    expect(derivedNoAuto).not.toBe(derivedAuto);
    h.listAllActiveAlerts.mockResolvedValue([makeAlert({ cardId: "cs-uuid-with-no-rows" })]);
    h.catalogSlugIfExists.mockImplementation(async (slug: string) => (slug === derivedNoAuto ? derivedNoAuto : null));
    h.valueIdentity.mockImplementation(async (req: Record<string, unknown>) =>
      (req.id === derivedNoAuto ? priced(derivedNoAuto, 75) : unresolved()));

    const summary = await runPriceAlertEvaluator();

    expect(h.valueIdentity).toHaveBeenCalledTimes(2);
    expect(h.valueIdentity.mock.calls[0][0]).toMatchObject({ id: "cs-uuid-with-no-rows" });
    expect(h.valueIdentity.mock.calls[1][0]).toMatchObject({ id: derivedNoAuto, grade: { company: "PSA", value: 10 } });
    expect(h.catalogSlugIfExists).toHaveBeenCalledTimes(2);
    expect(h.catalogSlugIfExists.mock.calls.map((c) => c[0]).sort()).toEqual([derivedNoAuto, derivedAuto].sort());
    expect(h.recordAlertEvaluation).toHaveBeenCalledWith("user-1", "alert-1", { currentPrice: 75, triggered: true });
    expect(summary).toMatchObject({ triggered: 1, skippedNoIdentity: 0, skippedAmbiguousIdentity: 0 });
    expect(h.computeEstimate).not.toHaveBeenCalled();
  });

  it("the catalog holds BOTH auto forms of the derived slug: ambiguous — skipped with its reason, a null evaluation recorded, nothing priced, no push", async () => {
    h.listAllActiveAlerts.mockResolvedValue([makeAlert({ cardId: "cs-uuid-with-no-rows" })]);
    h.catalogSlugIfExists.mockImplementation(async (slug: string) => slug);
    h.valueIdentity.mockResolvedValue(unresolved());

    const summary = await runPriceAlertEvaluator();

    expect(h.valueIdentity).toHaveBeenCalledTimes(1);   // the cardId resolution only
    expect(h.recordAlertEvaluation).toHaveBeenCalledWith("user-1", "alert-1", { currentPrice: null, triggered: false });
    expect(h.sendPriceAlertNotification).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ evaluated: 1, skippedAmbiguousIdentity: 1, skippedNoIdentity: 0, triggered: 0, unchanged: 0, pricingErrors: 0 });
  });

  it("no identity anywhere (cardId unmapped, the snapshot's slug not in the catalog): skipped, counted, never priced from text", async () => {
    h.listAllActiveAlerts.mockResolvedValue([makeAlert({ cardId: "cs-uuid-with-no-rows" })]);
    h.valueIdentity.mockResolvedValue(unresolved());

    const summary = await runPriceAlertEvaluator();

    expect(h.valueIdentity).toHaveBeenCalledTimes(1);
    expect(h.computeEstimate).not.toHaveBeenCalled();
    expect(h.recordAlertEvaluation).toHaveBeenCalledWith("user-1", "alert-1", { currentPrice: null, triggered: false });
    expect(h.sendPriceAlertNotification).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ evaluated: 1, skippedNoIdentity: 1, triggered: 0, unchanged: 0, pricingErrors: 0 });
  });

  it("a snapshot without the minimum identity (no card number) derives nothing; a Raw grade is the Raw tier", () => {
    expect(snapshotSlugCandidates({ cardSnapshot: { playerName: "x", year: 2011, setName: "Topps Update", cardNumber: null } })).toEqual([]);
    expect(snapshotSlugCandidates({ cardSnapshot: null })).toEqual([]);
    const both = snapshotSlugCandidates({ cardSnapshot: { playerName: "x", year: 2011, setName: "Topps Update", cardNumber: "US175", variant: "Gold", printRun: 2011 } });
    expect(both).toHaveLength(2);
    // D23 (CF-THE-ID-CARRIES-THE-PRODUCT): "Topps Update" is the Update Series product, one spelling.
    expect(both.every((s) => s.startsWith("hiq:baseball:2011:topps-update-series:"))).toBe(true);
    expect(parseAlertGrade("PSA 10")).toEqual({ company: "PSA", value: 10 });
    expect(parseAlertGrade("bgs 9.5")).toEqual({ company: "BGS", value: 9.5 });
    expect(parseAlertGrade("Raw")).toBeNull();
    expect(parseAlertGrade(null)).toBeNull();
    expect(parseAlertGrade("PSA")).toBeNull();
  });
});

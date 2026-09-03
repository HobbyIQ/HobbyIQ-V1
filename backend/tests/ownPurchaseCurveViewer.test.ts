/**
 * CF-OWN-PURCHASE-IS-A-SALE (Drew, 2026-09-03) — the grade-curve disclosure,
 * pinned through the REAL builder.
 *
 * The refutation this answers: `aggregateGrade(cardId, cfg, viewerUserId?)`
 * was the only reader of viewerUserId, and its one production caller
 * (`CANONICAL_GRADES.map((cfg) => aggregateGrade(cardId, cfg))`) never passed
 * it. So `ownSampleCount` was provably always 0 in prod no matter how many of
 * a tier samples were the viewer own purchases — the disclosure the ruling
 * asks for existed only as a field name. A unit test that calls isOwnComp
 * directly cannot see that; only driving buildObservedGradeCurve can.
 *
 * Fixture: the Verlander shape. PSA 10 has the own $251 purchase plus two
 * independent vendor sales; PSA 9 has vendor sales only.
 *
 * Mutation: drop the `opts.viewerUserId` argument from the aggregateGrade
 * call in observedGradeCurve.service.ts and the PSA 10 assertion reds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.COMPIQ_CORPUS_DISABLED = "1";
delete process.env.COSMOS_CONNECTION_STRING;

const DREW = "user-drew";
const SOMEONE_ELSE = "user-other";
const CARD = "hiq:baseball:2024:topps-chrome:150:base:no-auto";

const h = vi.hoisted(() => ({
  byGrade: new Map<string, Array<Record<string, unknown>>>(),
}));

// The one Cosmos seam the curve reads through (CF-GRADE-CURVE-TEST-SEAM).
vi.mock("../src/services/compiq/soldCompsGradeReader.js", () => ({
  readSoldCompsForGrade: vi.fn(async (_cardId: string, grade: string) =>
    h.byGrade.get(grade) ?? []),
}));

// Trajectory / trend inputs are irrelevant here: null keeps them silent so
// the only thing under test is the per-tier basis disclosure.
vi.mock("../src/services/playerTrend/index.js", () => ({
  getPlayerTrendSnapshot: vi.fn(async () => null),
}));
vi.mock("../src/services/playerTrend/cardHedgeMatchedCohortProvider.js", () => ({
  fetchCardHedgeMatchedCohort: vi.fn(async () => null),
}));
vi.mock("../src/services/playerTrend/matchedCohortCache.js", () => ({
  readMatchedCohortFromCache: vi.fn(async () => null),
  writeMatchedCohortToCache: vi.fn(async () => undefined),
}));
vi.mock("../src/services/playerTrend/parallelTierTrend.service.js", () => ({
  getParallelTierTrend: vi.fn(async () => null),
}));

import { buildObservedGradeCurve } from "../src/services/compiq/observedGradeCurve.service.js";

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

/** The D38 import shape: ebay-user-purchase, contributor set, verified FALSE. */
const ownPurchase = () => ({
  price: 251, soldAt: daysAgo(6), source: "ebay-user-purchase",
  contributorUserId: DREW, listingType: "AUCTION",
  title: "2024 Topps Chrome Justin Verlander #150 PSA 10",
});
const vendorSale = (price: number, d: number) => ({
  price, soldAt: daysAgo(d), source: "cardhedge",
  contributorUserId: null, listingType: "AUCTION",
  title: "2024 Topps Chrome Justin Verlander #150 PSA 10",
});

const tier = (curve: { entries: Array<{ grade: string; sampleCount: number; ownSampleCount: number }> }, grade: string) =>
  curve.entries.find((e) => e.grade === grade)!;

beforeEach(() => {
  h.byGrade = new Map<string, Array<Record<string, unknown>>>([
    ["PSA 10", [ownPurchase(), vendorSale(260, 12), vendorSale(245, 20)]],
    ["PSA 9", [vendorSale(120, 9), vendorSale(115, 15)]],
  ]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("buildObservedGradeCurve -- the tier discloses how many of its samples are the viewer own", () => {
  it("MUTATION PIN: with a viewer, PSA 10 reports sampleCount 3 / ownSampleCount 1", async () => {
    const curve = await buildObservedGradeCurve(CARD, { viewerUserId: DREW });
    const psa10 = tier(curve, "PSA 10");
    // n is DISCLOSED, not reduced: the own purchase is one of the three.
    expect(psa10.sampleCount).toBe(3);
    expect(psa10.ownSampleCount).toBe(1);
    expect(psa10.ownSampleCount).toBeLessThan(psa10.sampleCount);
  });

  it("a tier with no own sales reports ownSampleCount 0 while still counting its n", async () => {
    const curve = await buildObservedGradeCurve(CARD, { viewerUserId: DREW });
    const psa9 = tier(curve, "PSA 9");
    expect(psa9.sampleCount).toBe(2);
    expect(psa9.ownSampleCount).toBe(0);
  });

  it("a tier whose ONLY sale is the own purchase still has n=1 -- never hidden", async () => {
    h.byGrade = new Map([["PSA 10", [ownPurchase()]]]);
    const curve = await buildObservedGradeCurve(CARD, { viewerUserId: DREW });
    const psa10 = tier(curve, "PSA 10");
    expect(psa10.sampleCount).toBe(1);
    expect(psa10.ownSampleCount).toBe(1);
  });

  it("another user purchase is NOT the viewer own -- it is an independent sample", async () => {
    const curve = await buildObservedGradeCurve(CARD, { viewerUserId: SOMEONE_ELSE });
    const psa10 = tier(curve, "PSA 10");
    expect(psa10.sampleCount).toBe(3);
    expect(psa10.ownSampleCount).toBe(0);
  });

  it("a viewer-less build (bulk reprice, cron) reports 0 BY DESIGN, with n intact", async () => {
    const curve = await buildObservedGradeCurve(CARD, {});
    const psa10 = tier(curve, "PSA 10");
    // There is no "your" for the disclosure to mean, so the count is 0 --
    // but the own row is still a sample, so n is unchanged.
    expect(psa10.sampleCount).toBe(3);
    expect(psa10.ownSampleCount).toBe(0);
  });
});

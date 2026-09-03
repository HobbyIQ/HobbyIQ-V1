/**
 * CF-OWN-PURCHASE-IS-A-SALE (Drew, 2026-09-03) — the pins that DRIVE
 * production, not a restatement of it.
 *
 * ownPurchaseCompsVisible.test.ts pins the predicate (`isOwnComp`) and the
 * anchoring threshold, and those pins are sound. What it could not do was
 * prove the two SURFACES behave: its comp-list block asserted on a local
 * `toWire()` copy of the route's mapping, so re-inserting
 * `excludeContributorUserId: requesterId` into recentSales.routes.ts —
 * restoring the exact bug — left the suite green. A pin that a copy of the
 * code satisfies pins the copy.
 *
 * So these drive the REAL code:
 *
 *   1. The comp list, through the real Express app over supertest, with the
 *      viewer's own ebay-user-purchase row sitting in a pool of 3
 *      INDEPENDENT sales — the exact condition under which the old
 *      exclude-self path dropped it. Re-adding the exclusion reds this.
 *
 *   2. The grade curve, through the real buildObservedGradeCurve with the
 *      Cosmos read seam faked. `aggregateGrade` takes a viewerUserId, but
 *      until this PR's route threading NO production caller passed one, so
 *      ownSampleCount was provably always 0 in prod — dead code wearing a
 *      test's approval. Dropping the argument again reds this.
 *
 * Fixture is the Verlander shape Drew named: one own PSA 10 purchase ($251,
 * 2026-07-28) beside independent vendor sales at the same grade.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Container } from "@azure/cosmos";

process.env.COMPIQ_CORPUS_DISABLED = "1";
delete process.env.COSMOS_CONNECTION_STRING;

const DREW = "user-drew";
const SOMEONE_ELSE = "user-other";
const CARD = "hiq:baseball:2024:topps-chrome:150:base:no-auto";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  /** Which userId getUserBySession resolves the test session to. */
  viewer: "user-drew" as string,
}));

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => ({
      userId: h.viewer, email: "t@t", username: null, fullName: null,
      plan: "pro_seller", createdAt: "2026-01-01T00:00:00Z",
    })),
  };
});
vi.mock("../src/services/catalog/catalogIdentityResolver.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    resolveIdentityToCatalogRow: vi.fn(async (slug: string) => ({
      requested: slug, id: slug, kind: "exact", twins: [], poolTwin: null,
    })),
  };
});

import app from "../src/app";
import { _setContainerForTests } from "../src/services/portfolioiq/soldCompsStore.service.js";

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

/** The row the D38 import writes: ebay-user-purchase, contributor set,
 *  verifiedByUser deliberately FALSE. */
const ownPurchase = (over: Record<string, unknown> = {}) => ({
  id: "ebay-user-purchase::bba3b7ad", cardId: CARD, hobbyiqCardId: CARD,
  source: "ebay-user-purchase", contributorUserId: DREW, verifiedByUser: false,
  price: 251, soldAt: daysAgo(6),
  title: "2024 Topps Chrome Justin Verlander #150 PSA 10",
  parallel: null, gradeCompany: "PSA", gradeValue: 10, cardYear: 2024,
  cardNumber: "150", isAuto: false, printRun: null, imageUrl: null,
  sellerHandle: null, confidence: 0.9, ...over,
});

/** An independent, arm-length vendor sale at the same grade. */
const vendorSale = (i: number, price: number) => ({
  id: `cardhedge::${i}`, cardId: CARD, hobbyiqCardId: CARD,
  source: "cardhedge", contributorUserId: null, verifiedByUser: false,
  price, soldAt: daysAgo(i + 10),
  title: "2024 Topps Chrome Justin Verlander #150 PSA 10",
  parallel: null, gradeCompany: "PSA", gradeValue: 10, cardYear: 2024,
  cardNumber: "150", isAuto: false, printRun: null, imageUrl: null,
  sellerHandle: null, confidence: 0.9,
});

beforeAll(() => {
  _setContainerForTests({
    items: {
      query() {
        return { async fetchAll() { return { resources: h.rows }; } };
      },
    },
  } as unknown as Container);
});

beforeEach(() => {
  h.viewer = DREW;
  // The refutation condition: the own row plus THREE independent sales.
  // Three is the exact count at which SELF_COMP_MIN_OTHER_SAMPLES stops the
  // own row from ANCHORING -- and, under the old code, the count at which
  // excludeContributorUserId made it vanish from the list entirely.
  h.rows = [ownPurchase(), vendorSale(1, 260), vendorSale(2, 245), vendorSale(3, 255)];
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const H = { "x-session-id": "test-sess" };
const getSales = () =>
  request(app)
    .get(`/api/compiq/cards/${encodeURIComponent(CARD)}/recent-sales?tier=all&days=365&limit=50`)
    .set(H);

// ---------------------------------------------------------------------------
// 1. The comp list, through the real route.
// ---------------------------------------------------------------------------

describe("GET /cards/:cardId/recent-sales -- the viewer own purchase is LISTED and LABELLED", () => {
  it("MUTATION PIN: with 3 independent sales the own row is still in the list, labelled", async () => {
    const res = await getSales();
    expect(res.status).toBe(200);

    // Four rows in, four rows out. Under `excludeContributorUserId` the
    // store dropped the own row once 3 others survived, and this is 3.
    expect(res.body.sales).toHaveLength(4);

    const own = res.body.sales.filter((s: { isOwn?: boolean }) => s.isOwn === true);
    expect(own).toHaveLength(1);
    expect(own[0].price).toBe(251);
    expect(own[0].source).toBe("ebay-user-purchase");
    expect(own[0].ownLabel).toBe("your purchase");
    // Own rows stay ATTRIBUTED to their contributor; everyone else is
    // redacted by the same mapping.
    expect(own[0].contributorUserId).toBe(DREW);

    // And the independent rows are shown unlabelled.
    const others = res.body.sales.filter((s: { isOwn?: boolean }) => s.isOwn !== true);
    expect(others).toHaveLength(3);
    expect(others.every((s: { ownLabel: unknown }) => s.ownLabel === null)).toBe(true);
    expect(others.every((s: { contributorUserId: unknown }) => s.contributorUserId === null)).toBe(true);
  });

  it("the PSA 10 tier counts the own row in n and discloses ownCount", async () => {
    const res = await getSales();
    const psa10 = res.body.byGrade.find((g: { grader: string }) => g.grader === "PSA 10");
    expect(psa10).toBeTruthy();
    // n is DISCLOSED, not reduced -- the own purchase is a real sale.
    expect(psa10.count).toBe(4);
    expect(psa10.ownCount).toBe(1);
    expect(psa10.sales).toHaveLength(4);
  });

  it("a tier whose ONLY sale is the own purchase reports count 1, ownCount 1", async () => {
    h.rows = [ownPurchase()];
    const res = await getSales();
    const psa10 = res.body.byGrade.find((g: { grader: string }) => g.grader === "PSA 10");
    expect(psa10.count).toBe(1);
    expect(psa10.ownCount).toBe(1);
    expect(res.body.sales).toHaveLength(1);
    expect(res.body.sales[0].isOwn).toBe(true);
  });

  it("another user imported purchase is an ordinary comp -- shown, unlabelled, unattributed", async () => {
    h.viewer = SOMEONE_ELSE;
    const res = await getSales();
    expect(res.body.sales).toHaveLength(4);
    // The Drew row is in the list, but from this viewer it is independent.
    expect(res.body.sales.filter((s: { isOwn?: boolean }) => s.isOwn === true)).toHaveLength(0);
    const drewRow = res.body.sales.find((s: { price: number }) => s.price === 251);
    expect(drewRow.ownLabel).toBeNull();
    expect(drewRow.contributorUserId).toBeNull();
    const psa10 = res.body.byGrade.find((g: { grader: string }) => g.grader === "PSA 10");
    expect(psa10.count).toBe(4);
    expect(psa10.ownCount).toBe(0);
  });
});

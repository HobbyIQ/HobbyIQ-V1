/**
 * EBAY-POLL-INGESTION-C1 (2026-06-01) — pollEbayOrdersForUser tests.
 * CF-THE-ACCOUNT-SYNC-RESOLVES-EVERY-SALE (D26, 2026-08-30).
 *
 * ONE PINNED INVARIANT IS DELIBERATELY INVERTED HERE, and it is the whole
 * point of D26. This file used to assert:
 *
 *   "no-match: cursor does NOT advance past unmatched order"
 *
 * That assertion was correct for the design it was written against and it
 * pinned the bug in place. With `matched=0` on every cycle — which is what
 * production did for three months, 5,849 no-match events over 29 listings that
 * never changed — a cursor that only moves past MATCHED orders never moves at
 * all. `lastPolledAt` was NULL on all eight live connection docs.
 *
 * The rule now: a no-match is a PROCESSED order. So is a parked line, and so
 * is a sale recorded without a holding. Only a WRITE that did not happen pins
 * the cursor. The test below asserts the inversion explicitly rather than
 * quietly deleting the old one.
 *
 * Also covered: the resolve→record→mark ladder, the disjointness of the two
 * pool paths (exactly one row per sale), reconnect-required skipping, and the
 * dry-run's write silence.
 *
 * Mock strategy: vi.mock for the collaborator modules + the test-only impl
 * swaps via __ebayOrderPollInternals so we never stub global fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  readTokenRecord,
  writeTokenRecord,
  markReconnectRequired,
  connectionStatusOf,
} from "../src/services/ebay/ebayTokenStore.service.js";
import { getAccessToken, isTerminalTokenError } from "../src/services/ebay/ebayAuth.service.js";
import {
  findHoldingByEbayListingIdAcrossUsers,
  markHoldingSoldFromEbay,
  findSellerHoldingForIdentity,
  upsertEbayAccountSale,
  poolIdentityForHolding,
} from "../src/services/portfolioiq/portfolioStore.service.js";
import { recordSoldComp } from "../src/services/portfolioiq/soldCompsStore.service.js";
import {
  pollEbayOrdersForUser,
  __ebayOrderPollInternals,
} from "../src/services/ebay/ebayOrderPoll.service.js";
import type { EbaySaleIdentity } from "../src/services/ebay/ebayAccountSaleIdentity.service.js";

vi.mock("../src/services/ebay/ebayTokenStore.service.js", () => ({
  readTokenRecord: vi.fn(),
  writeTokenRecord: vi.fn(),
  markReconnectRequired: vi.fn(async () => true),
  connectionStatusOf: vi.fn((r: any) =>
    r?.connectionStatus === "reconnect-required" ? "reconnect-required" : "ok",
  ),
}));
vi.mock("../src/services/ebay/ebayAuth.service.js", () => ({
  getAccessToken: vi.fn(),
  isTerminalTokenError: vi.fn((m: string) => /invalid_grant|\b400\b|\b401\b/i.test(String(m))),
}));
vi.mock("../src/services/portfolioiq/portfolioStore.service.js", () => ({
  findHoldingByEbayListingIdAcrossUsers: vi.fn(),
  markHoldingSoldFromEbay: vi.fn(),
  findSellerHoldingForIdentity: vi.fn(),
  upsertEbayAccountSale: vi.fn(async () => ({ entry: {} as any, replay: false, written: true })),
  poolIdentityForHolding: vi.fn(),
}));
vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", () => ({
  recordSoldComp: vi.fn(),
}));

const USER_ID = "admin-testing-hobbyiq";
const CONNECTED_AT = "2026-05-08T18:57:36.368Z";
const PRIOR_CURSOR = "2026-06-01T10:00:00.000Z";
const SLUG = "hiq:baseball:2018:topps-chrome:150:refractor:no-auto";

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    ebayUserId: "dvabs",
    accessToken: "irrelevant-mocked",
    refreshToken: "irrelevant-mocked",
    accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    refreshTokenExpiresAt: Date.now() + 18 * 30 * 24 * 60 * 60 * 1000,
    scopes: [] as string[],
    connectedAt: CONNECTED_AT,
    lastPolledAt: PRIOR_CURSOR,
    ...overrides,
  };
}

function order(opts: {
  orderId: string;
  lastModifiedDate: string;
  creationDate?: string;
  listingId: string;
  quantity?: number;
  unitPrice?: number;
  title?: string;
}) {
  return {
    orderId: opts.orderId,
    creationDate: opts.creationDate ?? opts.lastModifiedDate,
    lastModifiedDate: opts.lastModifiedDate,
    orderFulfillmentStatus: "FULFILLED",
    orderPaymentStatus: "PAID",
    buyer: { username: "test_buyer" },
    lineItems: [
      {
        lineItemId: `LI-${opts.orderId}`,
        legacyItemId: opts.listingId,
        title: opts.title ?? "2018 Topps Chrome Shohei Ohtani #150 Refractor PSA 10",
        quantity: opts.quantity ?? 1,
        lineItemCost: { value: String(opts.unitPrice ?? 25.0), currency: "USD" },
      },
    ],
    pricingSummary: { total: { value: String(opts.unitPrice ?? 25.0), currency: "USD" } },
  };
}

/** A canned identity answer, so these tests never touch the catalog. */
function identity(over: Partial<EbaySaleIdentity> = {}): EbaySaleIdentity {
  return {
    resolution: "auto",
    slug: SLUG,
    confidence: 0.97,
    matchedBy: "exact",
    reason: null,
    fields: {
      sport: "baseball",
      year: 2018,
      setName: "Topps Chrome",
      player: "Shohei Ohtani",
      cardNumber: "150",
      parallel: "Refractor",
      isAuto: false,
      printRun: null,
      gradeCompany: "PSA",
      gradeValue: 10,
      imageUrl: null,
    },
    parsed: {} as any,
    derived: null,
    ...over,
  } as EbaySaleIdentity;
}

function useIdentity(id: EbaySaleIdentity | (() => EbaySaleIdentity)) {
  __ebayOrderPollInternals.setResolveIdentityImpl(
    async () => (typeof id === "function" ? id() : id),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAccessToken).mockResolvedValue("test-access-token-mocked");
  vi.mocked(isTerminalTokenError).mockImplementation((m: string) =>
    /invalid_grant|\b400\b|\b401\b|refresh token expired/i.test(String(m)),
  );
  vi.mocked(connectionStatusOf).mockImplementation((r: any) =>
    r?.connectionStatus === "reconnect-required" ? "reconnect-required" : "ok",
  );
  vi.mocked(poolIdentityForHolding).mockReturnValue({
    cardId: SLUG, hobbyiqCardId: SLUG, printRun: null, vendorCardId: null, via: "hobbyiqCardId",
  } as any);
  vi.mocked(findHoldingByEbayListingIdAcrossUsers).mockResolvedValue(null);
  vi.mocked(findSellerHoldingForIdentity).mockResolvedValue(null);
  vi.mocked(recordSoldComp).mockResolvedValue({ written: true, id: "sc-1", deduped: false } as any);
  vi.mocked(upsertEbayAccountSale).mockResolvedValue({ entry: {} as any, replay: false, written: true });
  useIdentity(identity());
});

afterEach(() => {
  __ebayOrderPollInternals.resetFetchPageImpl();
  __ebayOrderPollInternals.resetResolveIdentityImpl();
  vi.restoreAllMocks();
});

// ─── EMPTY POLL — the explicit monotonic case ────────────────────────────

describe("pollEbayOrdersForUser — EMPTY POLL: cursor unchanged", () => {
  it("getOrders returns empty list → cursor not advanced, writeTokenRecord NOT called", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({ orders: [] }));

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.status).toBe("ok");
    expect(result.ordersFetched).toBe(0);
    expect(result.lineItemsProcessed).toBe(0);
    expect(result.cursorBefore).toBe(PRIOR_CURSOR);
    expect(result.cursorAfter).toBe(PRIOR_CURSOR);
    expect(result.cursorAdvanced).toBe(false);
    expect(vi.mocked(writeTokenRecord)).not.toHaveBeenCalled();
    expect(vi.mocked(markHoldingSoldFromEbay)).not.toHaveBeenCalled();
  });
});

// ─── D26: THE INVERTED INVARIANT ─────────────────────────────────────────

describe("D26 — a no-match is PROCESSED: the cursor advances past it", () => {
  it("no holding at all → sale still recorded, cursor ADVANCES (this used to be pinned the other way)", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    const newCursor = "2026-06-01T15:00:00.000Z";
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({
      orders: [order({ orderId: "ORD-NOMATCH", lastModifiedDate: newCursor, listingId: "LIST-UNKNOWN" })],
    }));

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.noMatchingHolding).toBe(1);
    expect(result.holdingsMarked).toBe(0);
    // The sale is in the pool even though the user holds no such card.
    expect(result.recordedViaAccount).toBe(1);
    expect(result.recorded).toBe(1);
    // THE INVERSION.
    expect(result.ordersProcessed).toBe(1);
    expect(result.cursorAdvanced).toBe(true);
    expect(result.cursorAfter).toBe(newCursor);
    expect(vi.mocked(writeTokenRecord)).toHaveBeenCalledTimes(1);
  });

  it("a PARKED line advances the cursor too, and writes NO pool row", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    useIdentity(identity({ resolution: "parked", confidence: 0.72, matchedBy: "fuzzy-parallel" }));
    const newCursor = "2026-06-01T15:00:00.000Z";
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({
      orders: [order({ orderId: "ORD-PARK", lastModifiedDate: newCursor, listingId: "LIST-P" })],
    }));

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.parked).toBe(1);
    expect(result.resolvedAuto).toBe(0);
    expect(result.recorded).toBe(0);
    expect(vi.mocked(recordSoldComp)).not.toHaveBeenCalled();
    expect(result.ordersProcessed).toBe(1);
    expect(result.cursorAdvanced).toBe(true);

    // …but the user gets to SEE it: the sale record carries the proposal.
    const saved = vi.mocked(upsertEbayAccountSale).mock.calls[0][1];
    expect(saved.status).toBe("parked");
    expect(saved.cardId).toBeNull();
    expect(saved.proposedIdentity).toEqual({ slug: SLUG, confidence: 0.72, matchedBy: "fuzzy-parallel" });
  });

  it("an unresolvable line advances the cursor and parks with a reason", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    useIdentity(identity({ resolution: "unresolvable", slug: null, confidence: null, reason: "not-a-card" }));
    const newCursor = "2026-06-01T15:00:00.000Z";
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({
      orders: [order({ orderId: "ORD-BOX", lastModifiedDate: newCursor, listingId: "LIST-B", title: "2024 Topps Hobby Box" })],
    }));

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.unresolvable).toBe(1);
    expect(result.recorded).toBe(0);
    expect(result.cursorAdvanced).toBe(true);
    expect(vi.mocked(upsertEbayAccountSale).mock.calls[0][1].unresolvedReason).toBe("not-a-card");
  });

  it("a WRITE failure DOES pin the cursor — the one thing that still does", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    vi.mocked(recordSoldComp).mockResolvedValue({ written: false, reason: "error" } as any);
    const newCursor = "2026-06-01T15:00:00.000Z";
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({
      orders: [order({ orderId: "ORD-FAIL", lastModifiedDate: newCursor, listingId: "LIST-F" })],
    }));

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.failed).toBe(1);
    expect(result.recorded).toBe(0);
    expect(result.ordersProcessed).toBe(0);
    expect(result.cursorAdvanced).toBe(false);
    expect(result.cursorAfter).toBe(PRIOR_CURSOR);
    expect(vi.mocked(writeTokenRecord)).not.toHaveBeenCalled();
  });
});

// ─── D26: exactly one pool row per sale ──────────────────────────────────

describe("D26 — the two pool paths are disjoint: exactly one row per sale", () => {
  it("holding WITH a pinned identity → the ledger emit owns the row; the poll writes none", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    vi.mocked(findHoldingByEbayListingIdAcrossUsers).mockResolvedValue({
      userId: USER_ID, holdingId: "holding-abc", holding: { ebayOfferId: "OFFER-XYZ" } as any,
    });
    vi.mocked(markHoldingSoldFromEbay).mockResolvedValue({
      status: "marked-sold", entry: { id: "ledger-1" } as any, holdingRemoved: true, remainingQuantity: 0,
    });
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({
      orders: [order({ orderId: "ORD-1", lastModifiedDate: "2026-06-01T15:00:00.000Z", listingId: "LIST-1", unitPrice: 50 })],
    }));

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.holdingsMarked).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.recordedViaHolding).toBe(1);
    expect(result.recordedViaAccount).toBe(0);
    expect(result.recorded).toBe(1);
    expect(vi.mocked(recordSoldComp)).not.toHaveBeenCalled();
    expect(vi.mocked(upsertEbayAccountSale).mock.calls[0][1].poolWrittenBy).toBe("holding-ledger");
  });

  it("holding WITHOUT a pinned identity → the poll writes the ebay-account row", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    vi.mocked(findHoldingByEbayListingIdAcrossUsers).mockResolvedValue({
      userId: USER_ID, holdingId: "holding-unpinned", holding: {} as any,
    });
    // The holding carries no hiq slug, so markHoldingSoldFromEbay's own emit
    // WITHHOLDS the pool row (logUserCompWithheldNoIdentity). Without this
    // branch the sale would be lost from the pool entirely.
    vi.mocked(poolIdentityForHolding).mockReturnValue({
      cardId: null, hobbyiqCardId: null, printRun: null, vendorCardId: "ch-123", via: "none",
    } as any);
    vi.mocked(markHoldingSoldFromEbay).mockResolvedValue({
      status: "marked-sold", entry: {} as any, holdingRemoved: true, remainingQuantity: 0,
    });
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({
      orders: [order({ orderId: "ORD-2", lastModifiedDate: "2026-06-01T15:00:00.000Z", listingId: "LIST-2", unitPrice: 50 })],
    }));

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.holdingsMarked).toBe(1);
    expect(result.recordedViaHolding).toBe(0);
    expect(result.recordedViaAccount).toBe(1);
    expect(result.recorded).toBe(1);
    expect(vi.mocked(recordSoldComp)).toHaveBeenCalledTimes(1);
  });

  it("the ebay-account row is source `ebay-account`, GROSS price, keyed (orderId, lineItemId)", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({
      orders: [order({ orderId: "ORD-K", lastModifiedDate: "2026-06-01T15:00:00.000Z", listingId: "LIST-K", unitPrice: 412.5 })],
    }));

    await pollEbayOrdersForUser(USER_ID);

    const arg = vi.mocked(recordSoldComp).mock.calls[0][0];
    expect(arg.source).toBe("ebay-account");
    expect(arg.cardId).toBe(SLUG);
    expect(arg.price).toBe(412.5);
    expect(arg.sourceExternalId).toBe("ORD-K::LI-ORD-K");
    expect(arg.contributorUserId).toBe(USER_ID);
    expect(arg.gradeCompany).toBe("PSA");
    expect(arg.gradeValue).toBe(10);
  });

  it("finds the seller's holding by IDENTITY when no listing id matches", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    vi.mocked(findSellerHoldingForIdentity).mockResolvedValue({
      holdingId: "holding-by-slug", holding: {} as any, matchedBy: "identity-and-grade", holdingsWalked: 91,
    });
    vi.mocked(markHoldingSoldFromEbay).mockResolvedValue({
      status: "marked-sold", entry: {} as any, holdingRemoved: true, remainingQuantity: 0,
    });
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({
      orders: [order({ orderId: "ORD-S", lastModifiedDate: "2026-06-01T15:00:00.000Z", listingId: "LIST-S", unitPrice: 30 })],
    }));

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(vi.mocked(findSellerHoldingForIdentity)).toHaveBeenCalledWith(
      USER_ID, SLUG, { gradeCompany: "PSA", gradeValue: 10 },
    );
    expect(result.holdingsMarked).toBe(1);
    expect(vi.mocked(upsertEbayAccountSale).mock.calls[0][1].holdingMatchedBy).toBe("identity-and-grade");
  });

  it("a parked line is never asked to find a holding by identity — there is no identity", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    useIdentity(identity({ resolution: "parked", confidence: 0.7 }));
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({
      orders: [order({ orderId: "ORD-NP", lastModifiedDate: "2026-06-01T15:00:00.000Z", listingId: "LIST-NP" })],
    }));

    await pollEbayOrdersForUser(USER_ID);

    expect(vi.mocked(findSellerHoldingForIdentity)).not.toHaveBeenCalled();
  });
});

// ─── dedup → marked-sold-deduped counted, cursor still advances ──────────

describe("pollEbayOrdersForUser — dedup path", () => {
  it("markHoldingSoldFromEbay returns marked-sold-deduped → counted as deduped, cursor advances", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    vi.mocked(findHoldingByEbayListingIdAcrossUsers).mockResolvedValue({
      userId: USER_ID, holdingId: "holding-already-sold", holding: {} as any,
    });
    vi.mocked(markHoldingSoldFromEbay).mockResolvedValue({
      status: "marked-sold-deduped",
      entry: { id: "ledger-existing" } as any,
      holdingRemoved: false,
      remainingQuantity: 0,
    });
    const newCursor = "2026-06-01T15:00:00.000Z";
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({
      orders: [order({ orderId: "ORD-DUP", lastModifiedDate: newCursor, listingId: "LIST-DUP" })],
    }));

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.matched).toBe(0);
    expect(result.deduped).toBe(1);
    expect(result.holdingsMarked).toBe(1);
    expect(result.cursorAdvanced).toBe(true);
    expect(result.cursorAfter).toBe(newCursor);
  });
});

// ─── MONOTONIC GUARD — older order doesn't pull cursor back ──────────────

describe("pollEbayOrdersForUser — monotonic cursor: never below prior value", () => {
  it("matched order with lastModifiedDate BEFORE prior cursor → cursor stays at prior cursor", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    vi.mocked(findHoldingByEbayListingIdAcrossUsers).mockResolvedValue({
      userId: USER_ID, holdingId: "holding-ok", holding: {} as any,
    });
    vi.mocked(markHoldingSoldFromEbay).mockResolvedValue({
      status: "marked-sold", entry: {} as any, holdingRemoved: true, remainingQuantity: 0,
    });
    const olderDate = "2026-05-31T00:00:00.000Z";  // BEFORE PRIOR_CURSOR
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({
      orders: [order({ orderId: "ORD-OLD", lastModifiedDate: olderDate, listingId: "LIST-OLD" })],
    }));

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.matched).toBe(1);
    expect(result.ordersProcessed).toBe(1);
    expect(result.cursorAdvanced).toBe(false);
    expect(result.cursorAfter).toBe(PRIOR_CURSOR);
    expect(vi.mocked(writeTokenRecord)).not.toHaveBeenCalled();
  });
});

// ─── FETCH FAILURE — cursor unchanged + structured warn ──────────────────

describe("pollEbayOrdersForUser — fetch failure: cursor unchanged", () => {
  it("fetchPage throws → status=fetch-failed, cursor unchanged, no writes", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    __ebayOrderPollInternals.setFetchPageImpl(async () => {
      throw new Error("getOrders 502: bad gateway");
    });

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.status).toBe("fetch-failed");
    expect(result.error).toContain("502");
    expect(result.cursorAdvanced).toBe(false);
    expect(result.cursorAfter).toBe(PRIOR_CURSOR);
    expect(vi.mocked(writeTokenRecord)).not.toHaveBeenCalled();
    expect(vi.mocked(markHoldingSoldFromEbay)).not.toHaveBeenCalled();
  });
});

// ─── D26 deliverable 5: reconnect-required ───────────────────────────────

describe("D26 — an expired connection surfaces instead of failing hourly", () => {
  it("refresh token expired → status=refresh-token-expired, cursor unchanged", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    vi.mocked(getAccessToken).mockRejectedValue(
      new Error("eBay refresh token expired. Please reconnect your eBay account."),
    );

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.status).toBe("refresh-token-expired");
    expect(result.cursorAfter).toBe(PRIOR_CURSOR);
    expect(vi.mocked(writeTokenRecord)).not.toHaveBeenCalled();
  });

  it("eBay rejects the refresh grant → reconnect-required, and the reason is stored", async () => {
    // This is the live shape: two users, `accessExpired=true`,
    // `refreshExpired=false`, so the refresh branch runs and eBay says no.
    // The old code returned "fetch-failed" from here with NO log line at all,
    // which is why `ebay_poll_fetch_failed` had 0 occurrences in three days
    // while the counter read fetchFail=2 every hour.
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    vi.mocked(getAccessToken).mockRejectedValue(
      new Error("eBay token exchange failed: 400 invalid_grant"),
    );

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.status).toBe("reconnect-required");
    expect(vi.mocked(markReconnectRequired)).toHaveBeenCalledWith(
      USER_ID, expect.stringContaining("invalid_grant"),
    );
    expect(vi.mocked(writeTokenRecord)).not.toHaveBeenCalled();
  });

  it("a transient 5xx is NOT reconnect-required — a blip must not log a user out of their sync", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    vi.mocked(getAccessToken).mockRejectedValue(new Error("eBay token exchange failed: 503"));

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.status).toBe("fetch-failed");
    expect(vi.mocked(markReconnectRequired)).not.toHaveBeenCalled();
  });

  it("an already-marked user is SKIPPED before any eBay call", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(
      baseRecord({ connectionStatus: "reconnect-required", connectionStatusReason: "refresh rejected" }) as any,
    );

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.status).toBe("reconnect-required");
    expect(result.error).toBe("refresh rejected");
    expect(vi.mocked(getAccessToken)).not.toHaveBeenCalled();
    expect(vi.mocked(writeTokenRecord)).not.toHaveBeenCalled();
  });
});

// ─── D26: dry run writes nothing ─────────────────────────────────────────

describe("D26 — dryRun is REPORT ONLY", () => {
  it("resolves and counts, writes no pool row, no sale record, no cursor", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({
      orders: [order({ orderId: "ORD-DRY", lastModifiedDate: "2026-06-01T15:00:00.000Z", listingId: "LIST-D", unitPrice: 20 })],
    }));

    const result = await pollEbayOrdersForUser(USER_ID, { dryRun: true, since: "2026-06-01T00:00:00.000Z" });

    expect(result.resolvedAuto).toBe(1);
    expect(result.recordedViaAccount).toBe(1);   // what it WOULD have written
    expect(result.cursorAdvanced).toBe(false);
    expect(vi.mocked(recordSoldComp)).not.toHaveBeenCalled();
    expect(vi.mocked(upsertEbayAccountSale)).not.toHaveBeenCalled();
    expect(vi.mocked(markHoldingSoldFromEbay)).not.toHaveBeenCalled();
    expect(vi.mocked(writeTokenRecord)).not.toHaveBeenCalled();
  });
});

// ─── D26: the counters reconcile ─────────────────────────────────────────

describe("D26 — the funnel counters are disjoint and sum", () => {
  it("mixed batch: lines = auto + parked + unresolvable, and recorded = holding + account", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    const answers: EbaySaleIdentity[] = [
      identity(),                                                     // auto, no holding  -> account
      identity({ resolution: "parked", confidence: 0.6 }),            // parked            -> none
      identity({ resolution: "unresolvable", slug: null, reason: "not-a-card" }),
    ];
    let i = 0;
    useIdentity(() => answers[i++ % answers.length]);
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({
      orders: [
        order({ orderId: "A", lastModifiedDate: "2026-06-02T00:00:00.000Z", listingId: "L-A" }),
        order({ orderId: "B", lastModifiedDate: "2026-06-02T01:00:00.000Z", listingId: "L-B" }),
        order({ orderId: "C", lastModifiedDate: "2026-06-02T02:00:00.000Z", listingId: "L-C" }),
      ],
    }));

    const r = await pollEbayOrdersForUser(USER_ID);

    expect(r.lineItemsProcessed).toBe(3);
    expect(r.resolvedAuto + r.parked + r.unresolvable).toBe(r.lineItemsProcessed);
    expect(r.resolvedAuto).toBe(1);
    expect(r.parked).toBe(1);
    expect(r.unresolvable).toBe(1);
    expect(r.recordedViaHolding + r.recordedViaAccount).toBe(r.recorded);
    expect(r.recorded).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.ordersProcessed).toBe(3);
    // Every line is written, skipped or failed — the job's reconciliation.
    expect(r.recorded + (r.lineItemsProcessed - r.recorded - r.failed) + r.failed)
      .toBe(r.lineItemsProcessed);
  });
});

// ─── FIRST POLL / NO TOKEN — unchanged ───────────────────────────────────

describe("pollEbayOrdersForUser — first poll: uses connectedAt when lastPolledAt absent", () => {
  it("record with no lastPolledAt → cursorBefore = connectedAt", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord({ lastPolledAt: null }) as any);
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({ orders: [] }));

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.cursorBefore).toBe(CONNECTED_AT);
    expect(result.cursorAfter).toBe(CONNECTED_AT);
    expect(result.cursorAdvanced).toBe(false);
  });
});

describe("pollEbayOrdersForUser — no token record: clean exit", () => {
  it("readTokenRecord returns null → status=no-token, no fetch attempted", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(null);

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.status).toBe("no-token");
    expect(vi.mocked(getAccessToken)).not.toHaveBeenCalled();
    expect(vi.mocked(writeTokenRecord)).not.toHaveBeenCalled();
  });
});

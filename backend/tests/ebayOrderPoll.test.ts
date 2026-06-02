/**
 * EBAY-POLL-INGESTION-C1 (2026-06-01) — pollEbayOrdersForUser tests.
 *
 * Covers the design's load-bearing invariants:
 *   - match → calls markHoldingSoldFromEbay, advances cursor
 *   - no-match → structured warn, no markHoldingSoldFromEbay call, cursor
 *     does NOT advance past the unmatched order's lastModifiedDate
 *   - dedup → markHoldingSoldFromEbay returns marked-sold-deduped, counts
 *     as deduped, still advances cursor for the dedup'd order
 *   - EMPTY POLL → cursor unchanged (the explicit monotonic case)
 *   - cursor advance → max(prev cursor, max observed lastModifiedDate)
 *   - cursor NEVER goes below prior value (monotonic guard)
 *   - fetch failure → cursor unchanged + ebay_poll_fetch_failed warn
 *
 * Mock strategy: vi.mock for the 3 collaborator modules (auth /
 * tokenStore / portfolioStore) + the test-only fetchPage swap via
 * __ebayOrderPollInternals so we don't need to stub global fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  readTokenRecord,
  writeTokenRecord,
} from "../src/services/ebay/ebayTokenStore.service.js";
import { getAccessToken } from "../src/services/ebay/ebayAuth.service.js";
import {
  findHoldingByEbayListingIdAcrossUsers,
  markHoldingSoldFromEbay,
} from "../src/services/portfolioiq/portfolioStore.service.js";
import {
  pollEbayOrdersForUser,
  __ebayOrderPollInternals,
} from "../src/services/ebay/ebayOrderPoll.service.js";

vi.mock("../src/services/ebay/ebayTokenStore.service.js", () => ({
  readTokenRecord: vi.fn(),
  writeTokenRecord: vi.fn(),
}));
vi.mock("../src/services/ebay/ebayAuth.service.js", () => ({
  getAccessToken: vi.fn(),
}));
vi.mock("../src/services/portfolioiq/portfolioStore.service.js", () => ({
  findHoldingByEbayListingIdAcrossUsers: vi.fn(),
  markHoldingSoldFromEbay: vi.fn(),
}));

const USER_ID = "admin-testing-hobbyiq";
const CONNECTED_AT = "2026-05-08T18:57:36.368Z";
const PRIOR_CURSOR = "2026-06-01T10:00:00.000Z";

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
        title: "test item",
        quantity: opts.quantity ?? 1,
        lineItemCost: { value: String(opts.unitPrice ?? 25.0), currency: "USD" },
      },
    ],
    pricingSummary: { total: { value: String(opts.unitPrice ?? 25.0), currency: "USD" } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAccessToken).mockResolvedValue("test-access-token-mocked");
});

afterEach(() => {
  __ebayOrderPollInternals.resetFetchPageImpl();
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

// ─── match → markHoldingSoldFromEbay called, cursor advances ─────────────

describe("pollEbayOrdersForUser — match path", () => {
  it("single matched order → markHoldingSoldFromEbay called with null fees, cursor advances", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    vi.mocked(findHoldingByEbayListingIdAcrossUsers).mockResolvedValue({
      userId: USER_ID,
      holdingId: "holding-abc",
      holding: { ebayOfferId: "OFFER-XYZ" } as any,
    });
    vi.mocked(markHoldingSoldFromEbay).mockResolvedValue({
      status: "marked-sold",
      entry: { id: "ledger-1" } as any,
      holdingRemoved: true,
      remainingQuantity: 0,
    });
    const newCursor = "2026-06-01T15:00:00.000Z";  // newer than PRIOR_CURSOR
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({
      orders: [order({ orderId: "ORD-1", lastModifiedDate: newCursor, listingId: "LIST-1", unitPrice: 50 })],
    }));

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.status).toBe("ok");
    expect(result.ordersFetched).toBe(1);
    expect(result.lineItemsProcessed).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.deduped).toBe(0);
    expect(result.cursorAdvanced).toBe(true);
    expect(result.cursorAfter).toBe(newCursor);

    expect(vi.mocked(markHoldingSoldFromEbay)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(markHoldingSoldFromEbay).mock.calls[0];
    expect(call[0]).toBe(USER_ID);
    expect(call[1]).toBe("holding-abc");
    const data = call[2];
    expect(data.ebayOrderId).toBe("ORD-1");
    expect(data.ebayListingId).toBe("LIST-1");
    expect(data.ebayOfferId).toBe("OFFER-XYZ");
    expect(data.quantitySold).toBe(1);
    expect(data.unitSalePrice).toBe(50);
    // Fee fields explicitly null pending Finances enrichment.
    expect(data.finalValueFee).toBeNull();
    expect(data.netPayout).toBeNull();

    expect(vi.mocked(writeTokenRecord)).toHaveBeenCalledTimes(1);
    const written = vi.mocked(writeTokenRecord).mock.calls[0][0];
    expect(written.lastPolledAt).toBe(newCursor);
  });
});

// ─── no-match → cursor NOT advanced past that order ──────────────────────

describe("pollEbayOrdersForUser — no-match: cursor does NOT advance past unmatched order", () => {
  it("findHoldingByEbayListingIdAcrossUsers returns null → no markHoldingSoldFromEbay, cursor unchanged", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    vi.mocked(findHoldingByEbayListingIdAcrossUsers).mockResolvedValue(null);
    const newCursor = "2026-06-01T15:00:00.000Z";
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({
      orders: [order({ orderId: "ORD-NOMATCH", lastModifiedDate: newCursor, listingId: "LIST-UNKNOWN" })],
    }));

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.status).toBe("ok");
    expect(result.ordersFetched).toBe(1);
    expect(result.lineItemsProcessed).toBe(1);
    expect(result.noMatchingHolding).toBe(1);
    expect(result.matched).toBe(0);
    expect(result.cursorAdvanced).toBe(false);
    expect(result.cursorAfter).toBe(PRIOR_CURSOR);

    expect(vi.mocked(markHoldingSoldFromEbay)).not.toHaveBeenCalled();
    expect(vi.mocked(writeTokenRecord)).not.toHaveBeenCalled();
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
      status: "marked-sold",
      entry: {} as any,
      holdingRemoved: true,
      remainingQuantity: 0,
    });
    const olderDate = "2026-05-31T00:00:00.000Z";  // BEFORE PRIOR_CURSOR
    __ebayOrderPollInternals.setFetchPageImpl(async () => ({
      orders: [order({ orderId: "ORD-OLD", lastModifiedDate: olderDate, listingId: "LIST-OLD" })],
    }));

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.matched).toBe(1);
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

// ─── REFRESH TOKEN EXPIRED — clean status, cursor unchanged ──────────────

describe("pollEbayOrdersForUser — refresh token expired: clean exit", () => {
  it("getAccessToken throws 'refresh token expired' → status=refresh-token-expired, cursor unchanged", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(baseRecord() as any);
    vi.mocked(getAccessToken).mockRejectedValue(
      new Error("eBay refresh token expired. Please reconnect your eBay account."),
    );

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.status).toBe("refresh-token-expired");
    expect(result.cursorAfter).toBe(PRIOR_CURSOR);
    expect(vi.mocked(writeTokenRecord)).not.toHaveBeenCalled();
  });
});

// ─── FIRST POLL: lastPolledAt absent → uses connectedAt ──────────────────

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

// ─── NO TOKEN RECORD → clean exit ────────────────────────────────────────

describe("pollEbayOrdersForUser — no token record: clean exit", () => {
  it("readTokenRecord returns null → status=no-token, no fetch attempted", async () => {
    vi.mocked(readTokenRecord).mockResolvedValue(null);

    const result = await pollEbayOrdersForUser(USER_ID);

    expect(result.status).toBe("no-token");
    expect(vi.mocked(getAccessToken)).not.toHaveBeenCalled();
    expect(vi.mocked(writeTokenRecord)).not.toHaveBeenCalled();
  });
});

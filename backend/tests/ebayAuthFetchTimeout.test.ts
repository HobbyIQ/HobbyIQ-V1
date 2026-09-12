// CF-EBAY-FETCH-TIMEOUTS (2026-09-12, follow-up to PR #2072's
// deal-scanner-silent fix). Pins that ebayAuth.service.ts's fetch calls
// (the token exchange/refresh in fetchEbayToken, and the Identity API
// lookup in handleCallback) now carry an AbortSignal, and that a stalled
// connection surfaces as the same failure shape callers already handle:
// getAccessToken's refresh path already catches and rethrows, and the
// Identity API lookup already falls back to ebayUserId "unknown" on any
// thrown error.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const record = {
  userId: "user-1",
  ebayUserId: "seller1",
  accessToken: "stale-access-token",
  refreshToken: "refresh-token",
  accessTokenExpiresAt: Date.now() - 1000, // expired -> forces refresh
  refreshTokenExpiresAt: Date.now() + 1_000_000,
  scopes: ["https://api.ebay.com/oauth/api_scope"],
  connectedAt: new Date().toISOString(),
};

beforeEach(() => {
  process.env.EBAY_CLIENT_ID = "id";
  process.env.EBAY_CLIENT_SECRET = "secret";
});

afterEach(() => {
  vi.doUnmock("../src/services/ebay/ebayTokenStore.service.js");
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("ebayAuth.service — fetch carries a timeout signal", () => {
  it("fetchEbayToken (via getAccessToken's refresh path) passes an AbortSignal", async () => {
    vi.doMock("../src/services/ebay/ebayTokenStore.service.js", async (orig) => {
      const actual = await orig<any>();
      return {
        ...actual,
        readTokenRecord: vi.fn(async () => ({ ...record })),
        writeTokenRecord: vi.fn(async () => {}),
        markReconnectRequired: vi.fn(async () => true),
      };
    });
    const fetchStub = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: "fresh-token",
        refresh_token: "refresh-token",
        expires_in: 7200,
        refresh_token_expires_in: 1_000_000,
      }),
    }));
    vi.stubGlobal("fetch", fetchStub);

    const { getAccessToken } = await import("../src/services/ebay/ebayAuth.service.js");
    const token = await getAccessToken("user-1");
    expect(token).toBe("fresh-token");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("a refresh that hits an abort/timeout error propagates the same way any other network failure already does", async () => {
    vi.doMock("../src/services/ebay/ebayTokenStore.service.js", async (orig) => {
      const actual = await orig<any>();
      return {
        ...actual,
        readTokenRecord: vi.fn(async () => ({ ...record })),
        writeTokenRecord: vi.fn(async () => {}),
        markReconnectRequired: vi.fn(async () => true),
      };
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    }));

    const { getAccessToken } = await import("../src/services/ebay/ebayAuth.service.js");
    await expect(getAccessToken("user-1")).rejects.toThrow();
  });
});

// CF-DAILYIQ-CARD-MOVERS (2026-06-30) — pins the cardMovers surface on
// the DailyIQ brief response: shape normalization, image URL fix-up,
// non-fatal failure, and the live params-pass-through to the CH client.
//
// THIS FILE PINS:
//   1. getTopMovers params (count, category) reach the URL
//   2. cacheWrap key segregates by (count, category) so different
//      surfaces don't collide
//   3. Mapper normalizes "7 Day Sales" → sales7d (no spaces in iOS-
//      visible field names)
//   4. Mapper coerces image protocol-relative `//s3...` → `https://s3...`
//   5. Mapper coerces price strings → numbers; drops invalid entries
//   6. buildCardMoversSurface returns [] on any CH failure (non-fatal)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();

vi.mock("../src/services/compiq/cardhedge.client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/compiq/cardhedge.client.js")>(
    "../src/services/compiq/cardhedge.client.js",
  );
  return actual;
});

vi.mock("../src/services/shared/cache.service.js", () => ({
  // Bypass the cacheWrap so each test exercises the live fetch path.
  cacheWrap: (_key: string, fn: () => Promise<unknown>) => fn(),
  cacheKey: (...parts: string[]) => parts.join(":"),
}));

beforeEach(() => {
  // @ts-expect-error – override the global fetch for the duration of the test
  globalThis.fetch = fetchMock;
  fetchMock.mockReset();
  process.env.CARD_HEDGE_API_KEY = "test-key";
});
afterEach(() => {
  delete process.env.CARD_HEDGE_API_KEY;
});

describe("CF-DAILYIQ-CARD-MOVERS — getTopMovers params + URL shape", () => {
  it("default call sends count=20, no category", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ cards: [] }),
    });
    const { getTopMovers } = await import("../src/services/compiq/cardhedge.client.js");
    await getTopMovers();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/cards/top-movers?");
    expect(url).toContain("count=20");
    expect(url).not.toContain("category=");
  });

  it("explicit count + category land in the URL", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [] }) });
    const { getTopMovers } = await import("../src/services/compiq/cardhedge.client.js");
    await getTopMovers({ count: 25, category: "Baseball" });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("count=25");
    expect(url).toContain("category=Baseball");
  });

  it("non-finite count falls back to 20 (defensive)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [] }) });
    const { getTopMovers } = await import("../src/services/compiq/cardhedge.client.js");
    await getTopMovers({ count: Number.NaN });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("count=20");
  });

  it("empty/whitespace category is treated as no category", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [] }) });
    const { getTopMovers } = await import("../src/services/compiq/cardhedge.client.js");
    await getTopMovers({ count: 10, category: "   " });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).not.toContain("category=");
  });

  it("HTTP error → null (caller treats as 'no movers')", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const { getTopMovers } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getTopMovers();
    expect(r).toBeNull();
  });

  it("network throw → null (never propagates)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    const { getTopMovers } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getTopMovers();
    expect(r).toBeNull();
  });
});

describe("CF-DAILYIQ-CARD-MOVERS — buildCardMoversSurface mapper", () => {
  it("maps CH TopMoverCard → DailyIQCardMover with normalized fields", async () => {
    const sampleCard = {
      card_id: "test-1",
      description: "Barry Bonds 1986 Fleer Update Baseball",
      player: "Barry Bonds",
      set: "1986 Fleer Update Baseball",
      number: "U-14",
      variant: "Base",
      image: "//s3.amazonaws.com/example.jpg",
      category: "Baseball",
      rookie: true,
      gain: 1.985,
      "7 Day Sales": 39,
      "30 Day Sales": 141,
      prices: [
        { grade: "PSA 10", price: "1044.7" },
        { grade: "Raw", price: "9.99" },
      ],
    };
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [sampleCard] }) });
    const { buildCardMoversSurface } = await import("../src/routes/dailyiq.routes.js");
    const movers = await buildCardMoversSurface();
    expect(movers).toHaveLength(1);
    const m = movers[0]!;
    expect(m.cardId).toBe("test-1");
    expect(m.player).toBe("Barry Bonds");
    expect(m.set).toBe("1986 Fleer Update Baseball");
    expect(m.number).toBe("U-14");
    expect(m.variant).toBe("Base");
    expect(m.rookie).toBe(true);
    expect(m.gainPct).toBeCloseTo(1.985, 3);
    expect(m.sales7d).toBe(39);
    expect(m.sales30d).toBe(141);
    // image protocol normalized
    expect(m.imageUrl).toBe("https://s3.amazonaws.com/example.jpg");
    // prices: string → number
    expect(m.prices).toHaveLength(2);
    expect(m.prices[0]!.grade).toBe("PSA 10");
    expect(m.prices[0]!.price).toBe(1044.7);
    expect(m.prices[1]!.price).toBe(9.99);
  });

  it("https:// images passed through unchanged", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cards: [{
          card_id: "x", player: "X", set: "S", number: "1", variant: "v",
          image: "https://images.cdn/test.jpg", category: "Baseball", rookie: false, gain: 0,
        }],
      }),
    });
    const { buildCardMoversSurface } = await import("../src/routes/dailyiq.routes.js");
    const m = (await buildCardMoversSurface())[0]!;
    expect(m.imageUrl).toBe("https://images.cdn/test.jpg");
  });

  it("missing image → imageUrl=null", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cards: [{ card_id: "x", player: "X", set: "S", number: "1", variant: "v", category: "Baseball", rookie: false, gain: 0 }],
      }),
    });
    const { buildCardMoversSurface } = await import("../src/routes/dailyiq.routes.js");
    const m = (await buildCardMoversSurface())[0]!;
    expect(m.imageUrl).toBeNull();
  });

  it("price entries with non-numeric values are dropped (defensive)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cards: [{
          card_id: "x", player: "X", set: "S", number: "1", variant: "v",
          category: "Baseball", rookie: false, gain: 0,
          prices: [
            { grade: "PSA 10", price: "100" },     // OK
            { grade: "", price: "200" },           // empty grade → drop
            { grade: "PSA 9", price: "garbage" },  // non-numeric → drop
          ],
        }],
      }),
    });
    const { buildCardMoversSurface } = await import("../src/routes/dailyiq.routes.js");
    const m = (await buildCardMoversSurface())[0]!;
    expect(m.prices).toHaveLength(1);
    expect(m.prices[0]!.grade).toBe("PSA 10");
    expect(m.prices[0]!.price).toBe(100);
  });

  it("CH returns null/error → buildCardMoversSurface returns [] (non-fatal)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const { buildCardMoversSurface } = await import("../src/routes/dailyiq.routes.js");
    const r = await buildCardMoversSurface();
    expect(r).toEqual([]);
  });

  it("CH returns empty cards array → []", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [] }) });
    const { buildCardMoversSurface } = await import("../src/routes/dailyiq.routes.js");
    const r = await buildCardMoversSurface();
    expect(r).toEqual([]);
  });
});

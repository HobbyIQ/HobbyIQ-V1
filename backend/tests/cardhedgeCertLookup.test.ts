// CF-CH-CERT-NUMBER-LOOKUP (2026-07-04) — pins the getFmvByCert +
// getPricesByCert wrappers on the CardHedge client. Non-image cert
// lookup path for iOS slabs where the cert# is typed / barcode-scanned.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();

vi.mock("../src/services/shared/cache.service.js", () => ({
  cacheWrap: (_key: string, fn: () => Promise<unknown>) => fn(),
  cacheKey: (...parts: string[]) => parts.join(":"),
}));

beforeEach(() => {
  // @ts-expect-error – global fetch override
  globalThis.fetch = fetchMock;
  fetchMock.mockReset();
  process.env.CARD_HEDGE_API_KEY = "test-key";
});
afterEach(() => {
  delete process.env.CARD_HEDGE_API_KEY;
});

describe("CF-CH-CERT-NUMBER-LOOKUP — getFmvByCert", () => {
  it("POSTs to /cards/fmv-by-cert with cert + grader", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cert_info: { grader: "PSA", cert: "12345678", grade: "10" },
        card: { card_id: "c1", player: "Mike Trout" },
        fmv: { price: 2500 },
      }),
    });
    const { getFmvByCert } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getFmvByCert("12345678", "PSA");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/cards/fmv-by-cert");
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ cert: "12345678", grader: "PSA" });
    expect(r?.fmv?.price).toBe(2500);
    expect(r?.card?.card_id).toBe("c1");
  });

  it("returns null when API key missing (no HTTP)", async () => {
    delete process.env.CARD_HEDGE_API_KEY;
    const { getFmvByCert } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getFmvByCert("12345678", "PSA");
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when cert or grader is empty", async () => {
    const { getFmvByCert } = await import("../src/services/compiq/cardhedge.client.js");
    expect(await getFmvByCert("", "PSA")).toBeNull();
    expect(await getFmvByCert("12345678", "")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on non-2xx status", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    const { getFmvByCert } = await import("../src/services/compiq/cardhedge.client.js");
    expect(await getFmvByCert("12345678", "PSA")).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    const { getFmvByCert } = await import("../src/services/compiq/cardhedge.client.js");
    expect(await getFmvByCert("12345678", "PSA")).toBeNull();
  });
});

describe("CF-CH-CERT-NUMBER-LOOKUP — getPricesByCert", () => {
  it("POSTs to /cards/prices-by-cert with cert + grader + days (clamped)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        cert_info: { grader: "BGS", cert: "abcd", grade: "9.5" },
        card: { card_id: "c2", player: "Aaron Judge" },
        prices: [{ price: 500, date: "2026-06-15" }],
      }),
    });
    const { getPricesByCert } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getPricesByCert("abcd", "BGS", { days: 180 });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toEqual({ cert: "abcd", grader: "BGS", days: 180 });
    expect(r?.prices).toHaveLength(1);
  });

  it("clamps days to 1-365 range", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ cert_info: {grader:"PSA",cert:"c",grade:"10"}, card:null, prices:[] }) });
    const { getPricesByCert } = await import("../src/services/compiq/cardhedge.client.js");
    // days > 365 → clamps to 365
    await getPricesByCert("c", "PSA", { days: 500 });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).days).toBe(365);
    // days < 1 → clamps to 1
    fetchMock.mockClear();
    await getPricesByCert("c", "PSA", { days: 0 });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).days).toBe(1);
    // days omitted → 90 default
    fetchMock.mockClear();
    await getPricesByCert("c", "PSA");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).days).toBe(90);
  });

  it("returns null on failure paths (parity with getFmvByCert)", async () => {
    delete process.env.CARD_HEDGE_API_KEY;
    const { getPricesByCert } = await import("../src/services/compiq/cardhedge.client.js");
    expect(await getPricesByCert("c", "PSA")).toBeNull();
  });
});

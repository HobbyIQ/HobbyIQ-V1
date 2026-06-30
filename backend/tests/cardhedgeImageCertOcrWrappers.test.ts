// CF-CH-IMAGE-CERT-OCR (2026-06-30) — pins the 4 image/cert-OCR
// wrappers on the CardHedge client. Foundation for the iOS slab
// scanning project ([[grader-validation-iou]]).
//
// THIS FILE PINS:
//   1. Each wrapper posts to its correct CH endpoint with the right body
//   2. Image URL vs base64 routing (URL → cached; base64 → bypasses cache)
//   3. Cache key uses URL stem (query string stripped — SAS sigs rotate)
//   4. Missing image input → null (no HTTP call)
//   5. HTTP error / throw → null (never propagates)
//   6. Optional params (k for image-match/search, days for prices-by-cert)
//      land in the body

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

describe("CF-CH-IMAGE-CERT-OCR — identifyCardByImage", () => {
  it("imageUrl → POST /cards/image-match with image_url in body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, best_match: { card_id: "c1" }, candidates: [] }),
    });
    const { identifyCardByImage } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await identifyCardByImage({ imageUrl: "https://blob/photo.jpg" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/cards/image-match");
    const body = JSON.parse(opts.body as string);
    expect(body.image_url).toBe("https://blob/photo.jpg");
    expect(body.image_base64).toBeUndefined();
    expect(r?.best_match?.card_id).toBe("c1");
  });

  it("imageBase64 → POST /cards/image-match with image_base64", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, best_match: null, candidates: [] }),
    });
    const { identifyCardByImage } = await import("../src/services/compiq/cardhedge.client.js");
    await identifyCardByImage({ imageBase64: "abcd1234" });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.image_base64).toBe("abcd1234");
    expect(body.image_url).toBeUndefined();
  });

  it("k parameter lands in body when provided", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, best_match: null, candidates: [] }) });
    const { identifyCardByImage } = await import("../src/services/compiq/cardhedge.client.js");
    await identifyCardByImage({ imageUrl: "https://x/y" }, { k: 25 });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.k).toBe(25);
  });

  it("k omitted by default", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, best_match: null, candidates: [] }) });
    const { identifyCardByImage } = await import("../src/services/compiq/cardhedge.client.js");
    await identifyCardByImage({ imageUrl: "https://x/y" });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.k).toBeUndefined();
  });

  it("missing both inputs → null, no HTTP call", async () => {
    const { identifyCardByImage } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await identifyCardByImage({});
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("HTTP error → null", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const { identifyCardByImage } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await identifyCardByImage({ imageUrl: "https://x/y" });
    expect(r).toBeNull();
  });

  it("network throw → null (defensive)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("AI timeout"));
    const { identifyCardByImage } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await identifyCardByImage({ imageUrl: "https://x/y" });
    expect(r).toBeNull();
  });
});

describe("CF-CH-IMAGE-CERT-OCR — searchCardsByImage", () => {
  it("posts to /cards/image-search", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, results: [], total_results: 0 }),
    });
    const { searchCardsByImage } = await import("../src/services/compiq/cardhedge.client.js");
    await searchCardsByImage({ imageUrl: "https://x/y" });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/cards/image-search");
  });

  it("missing input → null", async () => {
    const { searchCardsByImage } = await import("../src/services/compiq/cardhedge.client.js");
    expect(await searchCardsByImage({})).toBeNull();
  });
});

describe("CF-CH-IMAGE-CERT-OCR — getCardDetailsByCertImage", () => {
  it("posts to /cards/details-by-cert-ocr", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ cert_info: { cert_number: "123", grader: "PSA" }, card: null }),
    });
    const { getCardDetailsByCertImage } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getCardDetailsByCertImage({ imageBase64: "xyz" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/cards/details-by-cert-ocr");
    expect(r?.cert_info?.cert_number).toBe("123");
  });

  it("body has NO `days` field (this endpoint doesn't accept it)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ cert_info: {}, card: null }) });
    const { getCardDetailsByCertImage } = await import("../src/services/compiq/cardhedge.client.js");
    await getCardDetailsByCertImage({ imageUrl: "https://x/y" });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.days).toBeUndefined();
  });
});

describe("CF-CH-IMAGE-CERT-OCR — getPricesByCertImage", () => {
  it("posts to /cards/prices-by-cert-ocr with days", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ cert_info: { cert_number: "123", grader: "PSA" }, card: null, prices: [] }),
    });
    const { getPricesByCertImage } = await import("../src/services/compiq/cardhedge.client.js");
    await getPricesByCertImage({ imageUrl: "https://x/y" }, { days: 180 });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.image_url).toBe("https://x/y");
    expect(body.days).toBe(180);
  });

  it("clamps days to [1, 365]", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ cert_info: {}, card: null, prices: [] }) });
    const { getPricesByCertImage } = await import("../src/services/compiq/cardhedge.client.js");
    await getPricesByCertImage({ imageUrl: "https://x/y" }, { days: 9999 });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.days).toBe(365);
  });

  it("days omitted by default", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ cert_info: {}, card: null, prices: [] }) });
    const { getPricesByCertImage } = await import("../src/services/compiq/cardhedge.client.js");
    await getPricesByCertImage({ imageUrl: "https://x/y" });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.days).toBeUndefined();
  });
});

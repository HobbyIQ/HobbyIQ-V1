// CF-INVENTORY-PHOTOS-TO-LISTING (2026-07-05) — pins the multi-image
// builder for eBay listings. Photos taken during inventory intake
// should flow to eBay listings automatically without iOS having to
// pick two.

import { describe, it, expect } from "vitest";
import {
  buildImages,
  type HoldingListingInput,
} from "../src/services/ebay/ebayListing.service.js";

function baseInput(overrides: Partial<HoldingListingInput> = {}): HoldingListingInput {
  return {
    holdingId: "h1",
    playerName: "Roldy Brito",
    cardTitle: "2026 Bowman Chrome Blue X-Fractor Auto",
    cardYear: 2026,
    brand: "Topps",
    setName: "2026 Bowman Chrome",
    product: "Bowman Chrome",
    isAuto: true,
    isPatch: false,
    isRookie: true,
    quantity: 1,
    listingPrice: 250,
    bestOfferEnabled: false,
    ...overrides,
  };
}

describe("CF-INVENTORY-PHOTOS-TO-LISTING — buildImages", () => {
  it("returns empty array when no images provided (byte-identical pre-CF)", () => {
    const imgs = buildImages(baseInput());
    expect(imgs).toEqual([]);
  });

  it("returns just front + back when only explicit URLs provided (pre-CF wire preserved)", () => {
    const imgs = buildImages(
      baseInput({
        imageFrontUrl: "https://cdn/front.jpg",
        imageBackUrl: "https://cdn/back.jpg",
      }),
    );
    expect(imgs).toEqual([
      { imageUrl: "https://cdn/front.jpg" },
      { imageUrl: "https://cdn/back.jpg" },
    ]);
  });

  it("consumes the photos[] array when provided without explicit front/back", () => {
    const imgs = buildImages(
      baseInput({
        photos: [
          "https://cdn/p1.jpg",
          "https://cdn/p2.jpg",
          "https://cdn/p3.jpg",
        ],
      }),
    );
    expect(imgs).toEqual([
      { imageUrl: "https://cdn/p1.jpg" },
      { imageUrl: "https://cdn/p2.jpg" },
      { imageUrl: "https://cdn/p3.jpg" },
    ]);
  });

  it("emits front + back FIRST, then photos[] (preserves gallery-image intent)", () => {
    const imgs = buildImages(
      baseInput({
        imageFrontUrl: "https://cdn/front.jpg",
        imageBackUrl: "https://cdn/back.jpg",
        photos: ["https://cdn/angle1.jpg", "https://cdn/angle2.jpg"],
      }),
    );
    expect(imgs.map((i) => i.imageUrl)).toEqual([
      "https://cdn/front.jpg",
      "https://cdn/back.jpg",
      "https://cdn/angle1.jpg",
      "https://cdn/angle2.jpg",
    ]);
  });

  it("dedupes when photos[] includes the same URL as imageFrontUrl", () => {
    const imgs = buildImages(
      baseInput({
        imageFrontUrl: "https://cdn/front.jpg",
        photos: [
          "https://cdn/front.jpg",   // dup of front
          "https://cdn/angle1.jpg",
        ],
      }),
    );
    expect(imgs.map((i) => i.imageUrl)).toEqual([
      "https://cdn/front.jpg",
      "https://cdn/angle1.jpg",
    ]);
  });

  it("filters non-HTTPS URLs (eBay requires HTTPS)", () => {
    const imgs = buildImages(
      baseInput({
        imageFrontUrl: "http://cdn/insecure.jpg",  // http, dropped
        photos: [
          "https://cdn/ok.jpg",
          "ftp://cdn/bad.jpg",       // ftp, dropped
          "not-a-url",                // garbage, dropped
        ],
      }),
    );
    expect(imgs.map((i) => i.imageUrl)).toEqual(["https://cdn/ok.jpg"]);
  });

  it("caps at 12 photos regardless of input length", () => {
    const photos = Array.from({ length: 20 }, (_, i) => `https://cdn/p${i}.jpg`);
    const imgs = buildImages(baseInput({ photos }));
    expect(imgs).toHaveLength(12);
    expect(imgs[0].imageUrl).toBe("https://cdn/p0.jpg");
    expect(imgs[11].imageUrl).toBe("https://cdn/p11.jpg");
  });

  it("ignores non-string entries in photos[] (defensive)", () => {
    const imgs = buildImages(
      baseInput({
        photos: [
          "https://cdn/ok.jpg",
          null as any,
          undefined as any,
          123 as any,
          "https://cdn/ok2.jpg",
        ],
      }),
    );
    expect(imgs.map((i) => i.imageUrl)).toEqual([
      "https://cdn/ok.jpg",
      "https://cdn/ok2.jpg",
    ]);
  });
});

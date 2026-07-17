// CF-ATTRIBUTION-PHASE-1-DHASH (2026-07-16). Pin the dHash algorithm +
// Hamming distance semantics. Pure-function tests — no sharp / no I/O.

import { describe, it, expect } from "vitest";
import { dhashFromGrayscale8x9, hammingHex, HASH_HEX_LEN } from "../src/services/attribution/phashCompute.service.js";

function makeGrid(bytesFn: (r: number, c: number) => number): Uint8Array {
  const arr = new Uint8Array(72);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 9; c++) {
      arr[r * 9 + c] = bytesFn(r, c) & 0xff;
    }
  }
  return arr;
}

describe("dhashFromGrayscale8x9", () => {
  it("returns a 16-char hex hash for a valid 72-byte input", () => {
    const grid = makeGrid((r, c) => (r * 9 + c) * 2);
    const hash = dhashFromGrayscale8x9(grid);
    expect(hash).not.toBeNull();
    expect(hash!.length).toBe(HASH_HEX_LEN);
    expect(hash!).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects wrong-size input", () => {
    expect(dhashFromGrayscale8x9(new Uint8Array(71))).toBeNull();
    expect(dhashFromGrayscale8x9(new Uint8Array(73))).toBeNull();
    expect(dhashFromGrayscale8x9(new Uint8Array(0))).toBeNull();
  });

  it("all-white and all-black inputs both hash to all-1 bits (each pixel >= right neighbor is true)", () => {
    // 255 >= 255 = true → 8 rows × 8 bits = 64 ones
    expect(dhashFromGrayscale8x9(makeGrid(() => 255))).toBe("ffffffffffffffff");
    // 0 >= 0 = true → same
    expect(dhashFromGrayscale8x9(makeGrid(() => 0))).toBe("ffffffffffffffff");
  });

  it("strict left-to-right darkening gives all-0 bits (255 → 0 → 0 >= 0 stays true on tail; 255 >= 0 is true)", () => {
    // Left-to-right: 200, 150, 100, 50, 0, 0, 0, 0, 0
    // Each pixel >= right neighbor → all bits set. Same as above.
    expect(dhashFromGrayscale8x9(makeGrid((_, c) => Math.max(0, 200 - c * 50)))).toBe("ffffffffffffffff");
  });

  it("strict left-to-right BRIGHTENING gives all-0 bits", () => {
    // 0, 30, 60, ..., 240 — each pixel < right neighbor → bits all 0
    const grid = makeGrid((_, c) => c * 30);
    expect(dhashFromGrayscale8x9(grid)).toBe("0000000000000000");
  });

  it("identical inputs hash identically", () => {
    const grid1 = makeGrid((r, c) => (r * 17 + c * 31) & 0xff);
    const grid2 = makeGrid((r, c) => (r * 17 + c * 31) & 0xff);
    expect(dhashFromGrayscale8x9(grid1)).toBe(dhashFromGrayscale8x9(grid2));
  });

  it("materially different inputs hash differently (Hamming distance > 0)", () => {
    const grid1 = makeGrid((r, c) => (r * 30 + c * 5) & 0xff);
    const grid2 = makeGrid((r, c) => ((r * 30 + c * 5) & 0xff) ^ 0x80);
    const h1 = dhashFromGrayscale8x9(grid1)!;
    const h2 = dhashFromGrayscale8x9(grid2)!;
    expect(h1).not.toBe(h2);
    expect(hammingHex(h1, h2)).toBeGreaterThan(0);
  });
});

describe("hammingHex", () => {
  it("returns 0 for identical hashes", () => {
    expect(hammingHex("0123456789abcdef", "0123456789abcdef")).toBe(0);
  });

  it("returns 64 for opposite hashes", () => {
    expect(hammingHex("0000000000000000", "ffffffffffffffff")).toBe(64);
  });

  it("returns 1 for single-bit flip", () => {
    expect(hammingHex("0000000000000000", "0000000000000001")).toBe(1);
  });

  it("returns 4 for one hex-nibble difference (opposite nibble)", () => {
    expect(hammingHex("0000000000000000", "f000000000000000")).toBe(4);
  });

  it("returns -1 for mismatched lengths", () => {
    expect(hammingHex("00", "0000000000000000")).toBe(-1);
  });

  it("returns -1 for non-hex characters", () => {
    expect(hammingHex("z000000000000000", "0000000000000000")).toBe(-1);
  });

  it("distance is symmetric", () => {
    const a = "0123456789abcdef";
    const b = "fedcba9876543210";
    expect(hammingHex(a, b)).toBe(hammingHex(b, a));
  });
});

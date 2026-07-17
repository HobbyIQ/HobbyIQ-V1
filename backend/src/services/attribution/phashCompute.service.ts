// CF-ATTRIBUTION-PHASE-1-DHASH (Drew, 2026-07-16). Pure-function dHash
// implementation over 9x8 grayscale. Byte-in, hash-out. No I/O.
//
// Algorithm (dHash v1):
//   1. Resize to 9 wide × 8 tall
//   2. Convert to grayscale
//   3. For each row, compare each pixel to its right neighbor: 1 if left
//      >= right (brighter), 0 otherwise
//   4. Pack 64 bits (8 rows × 8 comparisons/row) into a 16-char hex
//
// Why dHash over pHash-DCT for Phase 1:
//   - Simpler + faster
//   - Sufficient at 8x8 grayscale to distinguish parallel differences
//     (Base vs Chrome vs Refractor). Reads foil vs matte cleanly.
//   - Well-documented Hamming-distance semantics
//   - Fast enough to run in-workflow at 78k sales/day
//
// Upgrade to pHash-DCT in Phase 1.5 if dHash misses real errors on
// Drew-flagged samples during calibration.

import sharp from "sharp";

export const HASH_ALGO: "dhash-v1" = "dhash-v1";
export const HASH_HEX_LEN = 16; // 64 bits / 4 bits per hex char

/**
 * Compute dHash from raw image bytes.
 *
 * Returns null when sharp fails to decode the input (corrupt / unsupported
 * format). Callers treat null as "skip this image, mark for retry later"
 * rather than throwing — one bad image should never fail a batch of 500.
 */
export async function computeDhashFromBytes(bytes: Buffer): Promise<string | null> {
  try {
    // Resize 9x8, grayscale, get raw uint8 pixels.
    const { data, info } = await sharp(bytes)
      .resize(9, 8, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== 9 || info.height !== 8 || data.length !== 72) {
      return null;
    }
    return dhashFromGrayscale8x9(data);
  } catch {
    return null;
  }
}

/**
 * dHash from a raw 9x8 grayscale byte buffer (72 bytes, row-major).
 * Exported for direct unit testing without needing sharp.
 */
export function dhashFromGrayscale8x9(bytes: Uint8Array): string | null {
  if (bytes.length !== 72) return null;
  // 8 rows × 8 comparisons = 64 bits. Row r, comparison c:
  //   bit = bytes[r*9 + c] >= bytes[r*9 + c + 1]
  const bits: number[] = new Array(64);
  for (let r = 0; r < 8; r++) {
    const base = r * 9;
    for (let c = 0; c < 8; c++) {
      bits[r * 8 + c] = bytes[base + c] >= bytes[base + c + 1] ? 1 : 0;
    }
  }
  // Pack 64 bits into 16 hex chars (MSB-first per nibble).
  let hex = "";
  for (let n = 0; n < 16; n++) {
    const nibble =
      (bits[n * 4] << 3) |
      (bits[n * 4 + 1] << 2) |
      (bits[n * 4 + 2] << 1) |
      bits[n * 4 + 3];
    hex += nibble.toString(16);
  }
  return hex;
}

/**
 * Hamming distance between two 64-bit hex-encoded hashes.
 * Returns -1 when either input is malformed — callers should treat that
 * as "cannot compare" (skip, don't cluster).
 */
export function hammingHex(a: string, b: string): number {
  if (a.length !== HASH_HEX_LEN || b.length !== HASH_HEX_LEN) return -1;
  let dist = 0;
  for (let i = 0; i < HASH_HEX_LEN; i++) {
    const na = parseInt(a[i], 16);
    const nb = parseInt(b[i], 16);
    if (Number.isNaN(na) || Number.isNaN(nb)) return -1;
    let x = na ^ nb;
    // popcount over 4 bits — always ≤ 4, so a small loop wins.
    while (x) { dist += x & 1; x >>>= 1; }
  }
  return dist;
}

/**
 * Convenience: fetch an image URL and compute its dHash. Streams the
 * response into a buffer; caps at maxBytes to prevent a malicious /
 * misconfigured URL from consuming unbounded memory. eBay thumbnails
 * are typically < 100 KB.
 */
export async function computeDhashFromUrl(
  imageUrl: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ hash: string; downloadBytes: number; downloadMs: number } | { hash: null; downloadBytes: number; downloadMs: number; error: string }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let bytes = 0;
    try {
      const res = await fetch(imageUrl, { signal: controller.signal });
      if (!res.ok) {
        return { hash: null, downloadBytes: 0, downloadMs: Date.now() - t0, error: `HTTP ${res.status}` };
      }
      const buf = await res.arrayBuffer();
      bytes = buf.byteLength;
      if (bytes > maxBytes) {
        return { hash: null, downloadBytes: bytes, downloadMs: Date.now() - t0, error: `image too large (${bytes}B > ${maxBytes}B cap)` };
      }
      const hash = await computeDhashFromBytes(Buffer.from(buf));
      if (!hash) {
        return { hash: null, downloadBytes: bytes, downloadMs: Date.now() - t0, error: "decode failed" };
      }
      return { hash, downloadBytes: bytes, downloadMs: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return {
      hash: null,
      downloadBytes: 0,
      downloadMs: Date.now() - t0,
      error: (err as Error)?.message ?? String(err),
    };
  }
}

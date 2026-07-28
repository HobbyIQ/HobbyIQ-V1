// CF-IMAGE-VERIFY (Drew, 2026-07-28).
//
// The ONLY signal that resolves "is this comp really this card?" when
// the title lies. Every catalog entry gets a reference image + hash.
// Every persisted comp with an imageUrl gets hashed at ingest and
// compared to its catalog entry's reference. Mismatch → verify_queue.
//
// Algorithm: dHash (difference hash) via sharp.
//   1. Download the image, resize to 9×8 grayscale (72 pixels total).
//   2. For each of 8 rows, compare each pixel to its right neighbor.
//      64 comparisons → 64-bit hash → 16-char hex string.
//   3. Similarity = 1 - (hamming distance / 64).
//
// dHash instead of DCT-pHash: pure sharp pipeline (no manual DCT
// implementation to maintain), robust to compression + brightness
// changes, still discriminating enough for "different-card" detection
// on card imagery. Threshold tuning (via env / config) sets the
// flag rate.

import sharp from "sharp";

const HASH_BITS = 64;

/**
 * Compute a 64-bit dHash for the image at `url`. Returns 16-char
 * lowercase hex, or null when the URL is unreachable / decode fails.
 * Never throws.
 */
export async function computeImageHash(url: string): Promise<string | null> {
  if (!url || typeof url !== "string") return null;
  try {
    // Fetch as ArrayBuffer, then feed sharp.
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "image/*" },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) return null;

    // 9 cols × 8 rows grayscale → 72 pixels, then 8×8 = 64 comparisons.
    const { data } = await sharp(buf)
      .removeAlpha()
      .grayscale()
      .resize({ width: 9, height: 8, fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (data.length < 72) return null;

    // Encode 64 bits: for each row (y) and pair (x), left > right → 1.
    let hex = "";
    let bitBuf = 0;
    let bitCount = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const left = data[y * 9 + x];
        const right = data[y * 9 + x + 1];
        const bit = left > right ? 1 : 0;
        bitBuf = (bitBuf << 1) | bit;
        bitCount += 1;
        if (bitCount === 4) {
          hex += bitBuf.toString(16);
          bitBuf = 0;
          bitCount = 0;
        }
      }
    }
    return hex.padStart(16, "0");
  } catch {
    return null;
  }
}

/**
 * Hamming distance between two hex hashes (both 16 chars). Returns
 * the bit-difference count, 0 to 64. Higher = more different.
 * Both hashes must be 16-char hex; returns null otherwise.
 */
export function hammingDistance(a: string, b: string): number | null {
  if (!a || !b || a.length !== 16 || b.length !== 16) return null;
  let distance = 0;
  for (let i = 0; i < 16; i++) {
    const nibbleA = parseInt(a[i], 16);
    const nibbleB = parseInt(b[i], 16);
    if (Number.isNaN(nibbleA) || Number.isNaN(nibbleB)) return null;
    let xor = nibbleA ^ nibbleB;
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

/**
 * Similarity 0..1 between two hex hashes. 1 = identical, 0 = every
 * bit differs. Returns null on invalid inputs.
 */
export function imageSimilarity(a: string, b: string): number | null {
  const d = hammingDistance(a, b);
  if (d === null) return null;
  return 1 - d / HASH_BITS;
}

/**
 * Verdict for an ingest-time comparison. Threshold defaults tuned for
 * ~5% false-flag rate on Drew's spec — env-tunable so we can adjust
 * without a redeploy.
 *
 *   distance ≤ 10 (similarity ≥ 0.84) → "match"
 *   distance ≤ 20 (similarity ≥ 0.69) → "near-match" (caller can accept)
 *   distance >  20 (similarity <  0.69) → "mismatch" (route to verify)
 */
export type ImageVerdict = "match" | "near-match" | "mismatch";

export function classifyImageMatch(referenceHash: string, ingestHash: string): {
  verdict: ImageVerdict;
  distance: number | null;
  similarity: number | null;
} {
  const distance = hammingDistance(referenceHash, ingestHash);
  const similarity = distance !== null ? 1 - distance / HASH_BITS : null;
  const matchThreshold = Number(process.env.IMAGE_MATCH_MAX_DISTANCE ?? "10");
  const mismatchThreshold = Number(process.env.IMAGE_MISMATCH_MIN_DISTANCE ?? "20");
  if (distance === null) return { verdict: "mismatch", distance: null, similarity: null };
  const verdict: ImageVerdict = distance <= matchThreshold ? "match"
    : distance <= mismatchThreshold ? "near-match"
    : "mismatch";
  return { verdict, distance, similarity };
}

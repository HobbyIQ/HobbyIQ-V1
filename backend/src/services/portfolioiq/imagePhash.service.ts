// CF-IMAGE-PHASH (Drew, 2026-08-01). Perceptual image hashing to
// detect when two sold_comps rows show the SAME physical card.
//
// Algorithm: dHash (difference hash) — small, fast, robust to
// resize/compression:
//   1. Fetch image bytes
//   2. Resize to 9x8 grayscale
//   3. For each row, compare each pixel to its right neighbor →
//      1 bit per column pair, 8 rows × 8 comparisons = 64 bits
//   4. Encode as 16-char hex string
//   5. Hamming distance ≤ 8 bits (out of 64) = probable same image
//
// Two use cases:
//   - Within-slug: two rows same slug, same pHash → exact duplicate
//     (dedup candidate)
//   - Cross-slug: two rows different slugs, same pHash → one of them
//     is mis-slugged (flag for review)
//
// Called fire-and-forget from recordSoldComp for cardhedge + eBay
// sources with imageUrl.

import { CosmosClient, type Container } from "@azure/cosmos";

let _sharp: typeof import("sharp") | null = null;
async function getSharp(): Promise<typeof import("sharp") | null> {
  if (_sharp) return _sharp;
  try {
    const mod = await import("sharp");
    _sharp = (mod.default ?? mod) as typeof import("sharp");
    return _sharp;
  } catch { return null; }
}

/** Compute a 16-char hex dHash of the image at the given URL. Returns
 *  null on any failure (network / decode / library missing). */
export async function computeImageDHash(imageUrl: string): Promise<string | null> {
  if (!imageUrl || typeof imageUrl !== "string") return null;
  const sharp = await getSharp();
  if (!sharp) return null;
  try {
    // Bounded fetch — max 5MB, 5s timeout, image content types only
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(imageUrl, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!/^image\//.test(contentType)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return null;
    // Resize to 9x8 grayscale, extract raw pixel bytes
    const raw = await sharp(buf)
      .resize(9, 8, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();
    if (raw.length < 72) return null; // 9*8 = 72 bytes expected
    // dHash: for each of 8 rows, compare pixels[col] vs pixels[col+1] for cols 0..7
    let hash = 0n;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left = raw[row * 9 + col];
        const right = raw[row * 9 + col + 1];
        if (left < right) hash |= 1n << BigInt(row * 8 + col);
      }
    }
    // 64-bit → 16-char hex (zero-padded)
    return hash.toString(16).padStart(16, "0");
  } catch {
    return null;
  }
}

/** Hamming distance between two 16-char hex hashes. */
export function hashHammingDistance(a: string, b: string): number {
  if (a.length !== 16 || b.length !== 16) return 64;
  const ba = BigInt("0x" + a);
  const bb = BigInt("0x" + b);
  let x = ba ^ bb;
  let dist = 0;
  while (x !== 0n) {
    dist += Number(x & 1n);
    x >>= 1n;
  }
  return dist;
}

/** Given a row + its computed pHash, look for existing rows in the
 *  same slug with matching pHash (Hamming ≤ 8). Returns the matched
 *  row ids so caller can flag potential duplicates. */
export async function findPhashDuplicatesInSlug(
  container: Container,
  slug: string,
  incomingHash: string,
  excludeId: string,
): Promise<string[]> {
  if (!slug || !incomingHash) return [];
  try {
    const { resources } = await container.items.query({
      query: `SELECT c.id, c.__imagePhash FROM c
                WHERE c.hobbyiqCardId = @slug AND IS_DEFINED(c.__imagePhash)`,
      parameters: [{ name: "@slug", value: slug }],
    }, { maxItemCount: 100 }).fetchAll();
    const matches: string[] = [];
    for (const r of resources) {
      const rid = String((r as { id?: string }).id ?? "");
      if (rid === excludeId) continue;
      const other = String((r as { __imagePhash?: string }).__imagePhash ?? "");
      if (!other) continue;
      if (hashHammingDistance(incomingHash, other) <= 8) matches.push(rid);
    }
    return matches;
  } catch { return []; }
}

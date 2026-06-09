/**
 * CF-PLAYER-IN-SET-HISTORY (2026-06-09) — backend seed-queue writer.
 *
 * Appends (player, release, year) tuples to a lightweight needs-compute
 * list in blob storage. The nightly fn-comps-momentum extension reads
 * this list and computes/persists per-(player, release, year) momentum
 * snapshots + appends to a per-(player, release, year) history file.
 *
 * CF-PLAYER-IN-SET-RELEASE-KEY (2026-06-09): the tuple identity is
 * (player, release, year) — NOT (player, set, year). The literal
 * pricing.card.set.name from Cardsight is "Base Set" for every release's
 * main subset, so it collides across products. The release (e.g.
 * "Bowman Draft", "Topps Update") is the actual unique scope.
 *
 * This is the USAGE SEED — every card you price via /price-by-id queues
 * its (player, release) for the nightly precompute. That's what makes
 * the history cover Griffin and anything else you touch — not just the
 * 5 tracked players the legacy fn-comps-momentum knows about.
 *
 * Best-effort: a thrown blob op does NOT propagate up — the seed is
 * fire-and-forget at the caller. Worst-case: a missed nightly window
 * for one tuple, which the next /price-by-id call backfills.
 *
 * In-process dedupe: a Set caches seen (player, release, year) keys
 * within the current process so a hot-card request doesn't read+write
 * the blob on every call. The blob itself is also dedupe-keyed to handle
 * the cold-start + cross-instance case.
 *
 * Bound on queue growth: this layer does NOT cap. The nightly drains
 * up to MAX_PER_NIGHT (Python side) oldest-first; the rest carries.
 * For pre-launch sole-user traffic the seed cardinality is bounded by
 * actual usage and won't outrun the drain rate.
 *
 * Note: writes are best-effort with no transactional guarantees. Two
 * simultaneous /price-by-id calls for different tuples could race and
 * lose one append. Pre-launch sole-user → acceptable. If concurrency
 * grows, move dedupe to Redis SET or Cosmos.
 */

import { BlobServiceClient } from "@azure/storage-blob";

const CONTAINER = "compiq-signals";
const QUEUE_BLOB_PATH = "_seed/player-set-queue.json";

export interface PlayerSetSeedEntry {
  player: string;
  /** Release / product line — e.g. "Bowman Draft", "Topps Update". The
   *  unique-per-edition scope key, NOT the Cardsight set.name "Base Set". */
  release: string;
  year: number;
  /** ISO timestamp of when the tuple was first seeded — drives the
   *  nightly's oldest-first drain. */
  seenAt: string;
}

const seenInProcess = new Set<string>();

function tupleKey(t: { player: string; release: string; year: number }): string {
  return `${t.player.toLowerCase().trim()}|${t.release.toLowerCase().trim()}|${t.year}`;
}

let blobClientSingleton: BlobServiceClient | null = null;
function getBlobClient(): BlobServiceClient | null {
  if (blobClientSingleton) return blobClientSingleton;
  const conn = process.env.AZURE_BLOB_CONNECTION_STRING;
  if (!conn) return null;
  try {
    blobClientSingleton = BlobServiceClient.fromConnectionString(conn);
    return blobClientSingleton;
  } catch {
    return null;
  }
}

async function streamToBuffer(s: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    s.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    s.on("end", () => resolve(Buffer.concat(chunks)));
    s.on("error", reject);
  });
}

/** Append (player, release, year) to the seed queue if absent.
 *  Best-effort; never throws. Resolves quickly when:
 *    - input is invalid (empty player or release, or non-positive year)
 *    - in-process Set already saw the tuple this process lifetime
 *    - AZURE_BLOB_CONNECTION_STRING is unset (local / unconfigured)
 *  Otherwise reads the queue blob, appends if absent, writes back.
 *
 *  Year is REQUIRED: without it the nightly can't form the unique
 *  storage key (player + release + year). Callers that don't know
 *  the year shouldn't enqueue — better to skip than to write a
 *  malformed entry that the nightly will drop. */
export async function enqueuePlayerSetTuple(input: {
  player: string;
  release: string;
  year: number;
}): Promise<void> {
  const player = (input.player ?? "").trim();
  const release = (input.release ?? "").trim();
  const year = input.year;
  if (!player || !release) return;
  if (typeof year !== "number" || !Number.isFinite(year) || year <= 0) return;
  const key = tupleKey({ player, release, year });
  if (seenInProcess.has(key)) return;
  // Optimistic mark — don't re-read blob for this tuple within this
  // process even if the actual blob write fails. A failed write means
  // we miss this tuple's nightly until the in-process Set evicts (i.e.
  // never, within the same process). Acceptable for pre-launch sole-
  // user; the next process restart re-seeds.
  seenInProcess.add(key);

  const svc = getBlobClient();
  if (!svc) {
    // AZURE_BLOB_CONNECTION_STRING absent — nothing to do. Don't
    // log on every call; the once-at-boot warning would be louder
    // but we don't have a clean hook here. Stay silent.
    return;
  }

  try {
    const container = svc.getContainerClient(CONTAINER);
    await container.createIfNotExists().catch(() => {});
    const blob = container.getBlockBlobClient(QUEUE_BLOB_PATH);

    let existing: PlayerSetSeedEntry[] = [];
    try {
      const dl = await blob.download();
      if (dl.readableStreamBody) {
        const buf = await streamToBuffer(dl.readableStreamBody);
        const parsed = JSON.parse(buf.toString("utf8"));
        if (Array.isArray(parsed)) existing = parsed;
      }
    } catch (err: any) {
      // 404 → first-time blob, treat as empty list. Anything else
      // → fall back to empty list and let the upload below recreate it.
      if (err?.statusCode && err.statusCode !== 404) {
        console.warn(
          `[playerSetQueue] read failed (${err.statusCode}); proceeding from empty: ${(err as Error)?.message ?? err}`,
        );
      }
    }

    const existingKeys = new Set(
      existing
        .filter((e) => e && typeof e.release === "string" && typeof e.year === "number")
        .map((e) => tupleKey({ player: e.player, release: e.release, year: e.year })),
    );
    if (existingKeys.has(key)) {
      // Already in the queue — in-process Set will short-circuit
      // future calls.
      return;
    }

    existing.push({
      player,
      release,
      year,
      seenAt: new Date().toISOString(),
    });

    const body = JSON.stringify(existing);
    await blob.upload(body, body.length, {
      blobHTTPHeaders: { blobContentType: "application/json" },
    });
  } catch (err) {
    console.warn(
      `[playerSetQueue] enqueue failed (non-fatal): ${(err as Error)?.message ?? err}`,
    );
  }
}

/** Test hook: reset the in-process dedupe Set. NOT exported as part of
 *  the public contract. */
export function __resetSeenForTest(): void {
  seenInProcess.clear();
}

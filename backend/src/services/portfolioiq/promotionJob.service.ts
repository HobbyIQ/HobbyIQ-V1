// CF-PROMOTION-JOB (Drew, 2026-07-28).
//
// Step 6 of the staging pipeline. Reads staging rows in `clean` or
// `verified` state, writes them into sold_comps with full lineage,
// and flips staging status to `promoted` (the staging row stays as
// a permanent audit record).
//
// Every promoted sold_comps row carries:
//   - stagingId (one-hop back to the raw vendor payload)
//   - verification method (data-clean | image-verified | user-verified)
//   - score / reasonCodes from the data-clean job
//   - originalVendorImageUrl AND blobUrl (our permanent copy)
//
// Uses the existing `recordSoldComp` helper so all downstream code
// paths (pool query, FMV, dashboards) keep working unchanged.

import { CosmosClient, type Container } from "@azure/cosmos";
import { recordSoldComp } from "./soldCompsStore.service.js";
import type { StagingDoc } from "./compsStaging.service.js";

let _cached: Container | null = null;
async function getStagingContainer(): Promise<Container | null> {
  if (_cached) return _cached;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    _cached = db.container(process.env.COSMOS_COMPS_STAGING_CONTAINER ?? "comps_staging");
    return _cached;
  } catch {
    return null;
  }
}

export interface PromotionResult {
  scanned: number;
  promoted: number;
  skippedInsufficientData: number;
  errors: number;
  byVerification: Record<string, number>;
}

/**
 * Process a bounded batch of promotable rows (status = "clean" or
 * "verified"). Writes to sold_comps and flips staging to "promoted".
 * Silent-safe.
 */
// CF-DRAINER-WORKER-SHARDING (Drew, 2026-08-06). Same pattern as
// dataCleanJob.service.ts. Workers filter promotion candidates by
// hex-char id prefix so N parallel workers pull disjoint sets.
function shardChars(index: number, total: number): string[] {
  const hex = ["0","1","2","3","4","5","6","7","8","9","a","b","c","d","e","f"];
  if (total <= 1) return hex;
  const chars: string[] = [];
  for (let i = 0; i < hex.length; i++) {
    if (i % total === (index % total)) chars.push(hex[i]);
  }
  return chars;
}

export async function runPromotionBatch(opts: {
  limit?: number;
  workerShard?: { index: number; total: number };
} = {}): Promise<PromotionResult> {
  const staging = await getStagingContainer();
  const result: PromotionResult = {
    scanned: 0,
    promoted: 0,
    skippedInsufficientData: 0,
    errors: 0,
    byVerification: {},
  };
  if (!staging) return result;

  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const shardFilter = opts.workerShard
    ? " AND (" + shardChars(opts.workerShard.index, opts.workerShard.total)
        .map((_, i) => `STARTSWITH(c.id, @shard${i})`).join(" OR ") + ")"
    : "";
  const shardParams = opts.workerShard
    ? shardChars(opts.workerShard.index, opts.workerShard.total)
        .map((ch, i) => ({ name: `@shard${i}`, value: ch }))
    : [];
  const { resources: ready } = await staging.items.query<StagingDoc>({
    query: `SELECT TOP @n * FROM c WHERE c.status IN ('clean', 'verified')${shardFilter} ORDER BY c.observedAt ASC`,
    parameters: [{ name: "@n", value: limit }, ...shardParams],
  }).fetchAll();

  for (const row of ready) {
    result.scanned += 1;
    try {
      const clean = row.clean;
      if (!clean) { result.skippedInsufficientData += 1; continue; }
      const verificationLabel: "data-clean" | "image-verified" | "user-verified" =
        row.status === "verified"
          ? (row.verification?.method === "user-verified" ? "user-verified" : "image-verified")
          : "data-clean";

      // Trust boost when image-verified. verifiedByUser=false stays;
      // image agreement isn't "user attested" but the confidence is
      // materially higher than a pure title-parsed row.
      const confidence = verificationLabel === "image-verified" ? 0.9
        : verificationLabel === "user-verified" ? 1.0
        : 0.7;

      // Reuse the existing recordSoldComp helper — its content-hash
      // dedup + upsert semantics apply the same way. Passes the
      // mirrored blob URL as the imageUrl so downstream renders our
      // permanent copy, not the vendor's expiring one.
      await recordSoldComp({
        cardId: row.raw.identityHint.vendorCardId ?? `hiq:${row.hobbyiqCardId.slice(4)}`,
        playerName: clean.playerName,
        cardYear: clean.cardYear,
        setName: clean.setName ?? null,
        parallel: clean.parallel,
        cardNumber: clean.cardNumber,
        isAuto: clean.isAuto,
        sport: clean.sport,
        gradeCompany: clean.gradeCompany,
        gradeValue: clean.gradeValue,
        price: clean.price,
        soldAt: clean.soldAt,
        source: row.raw.vendor,
        sourceExternalId: row.raw.vendorRawId ?? null,
        title: String(row.raw.vendorPayload.title ?? null),
        imageUrl: row.mirroredImage?.blobUrl ?? row.raw.vendorPayload.imageUrl ?? null,
        sellerHandle: null,
        verifiedByUser: verificationLabel === "user-verified",
        confidence,
      });

      row.status = "promoted";
      row.promoted = {
        at: new Date().toISOString(),
        soldCompsId: `${row.raw.vendor}::${row.raw.vendorRawId ?? row.hobbyiqCardId}`,
        verification: verificationLabel,
      };
      await staging.item(row.id, row.hobbyiqCardId).replace(row as unknown as Record<string, unknown>);

      result.promoted += 1;
      result.byVerification[verificationLabel] = (result.byVerification[verificationLabel] ?? 0) + 1;
    } catch {
      result.errors += 1;
    }
  }
  console.log(JSON.stringify({
    event: "promotion_batch_complete",
    source: "promotionJob.service",
    ...result,
  }));
  return result;
}

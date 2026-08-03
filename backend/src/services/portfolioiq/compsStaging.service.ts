// CF-COMPS-STAGING (Drew, 2026-07-28).
//
// Immutable landing zone for every vendor comp before it earns its
// way into `sold_comps`. Container: `comps_staging`, partition
// /hobbyiqCardId.
//
// State machine:
//   pending          — just written, awaiting data-clean job
//   clean            — data-clean job resolved cleanly, ready to promote
//   anomaly          — data-clean flagged issues, awaits image-verify
//   verified         — image-verify confirmed identity, ready to promote
//   pending-manual   — image-verify inconclusive, awaits Drew in
//                      /app/admin/verify (no-reject rule)
//   promoted         — moved into sold_comps; row stays as lineage record
//
// A row never mutates its `raw` payload — corrections happen in the
// `clean` sub-object which the data-clean job writes and the promotion
// job reads. Same for `verification` (verify job writes, promotion
// reads).

import { CosmosClient, type Container } from "@azure/cosmos";
import { randomUUID, createHash } from "crypto";

export type StagingStatus =
  | "pending"
  | "clean"
  | "anomaly"
  | "verified"
  | "pending-manual"
  | "promoted"
  // CF-STAGING-REJECT-ZERO-PRICE (Drew, 2026-07-29). "There is no sales
  // at 0 dollars." Rows with price <= 0 are rejected outright and stay
  // out of the manual queue. Distinct from `promoted` so we can audit
  // what was tossed. Not to be confused with the general no-reject rule
  // (which applies to missing-image rows).
  | "rejected";

export type StagingVendor = "cardhedge" | "cardsight" | "ebay-user-purchase" | "ebay-user-sale" | "manual-user-entry" | "ebay-browse-ended" | "tca-ebay";

/** The unmodified vendor record — this half of the doc is IMMUTABLE. */
export interface StagingRaw {
  vendor: StagingVendor;
  vendorRawId: string | null;   // vendor's own id (cardhedge card_id, cardsight uuid, ebay item id)
  vendorPayload: {
    title: string | null;
    price: number | null | undefined;
    soldAt: string | null | undefined;
    url: string | null;
    imageUrl: string | null;
    externalId?: string | null;
    [k: string]: unknown;
  };
  identityHint: {
    playerName?: string | null;
    cardYear?: number | null;
    sport?: string | null;
    vendorCardId?: string | null;
  };
  fetchedAt: string;
  contentHash: string;   // sha256 of stable subset — cross-source dedup key
}

/** Result of the data-clean job. Written once; readers dependent on
 *  `status === "clean" | "anomaly"` before consuming. */
export interface StagingClean {
  cleanedAt: string;
  slug: string;                          // canonical hobbyiqCardId slug
  cardNumber: string | null;
  parallel: string | null;
  isAuto: boolean;
  printRun: number | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  setName: string | null;
  playerName: string;
  cardYear: number;
  sport: string;
  price: number;
  soldAt: string;
  // What the data-clean job DID — normalization rules that fired.
  normalizations: string[];
  // Anomaly reason codes when status="anomaly". Empty when status="clean".
  anomalies: Array<{
    kind: "price-outlier" | "parser-low-confidence" | "cross-grade-band" | "slug-conflict" | "no-image" | "unknown";
    detail?: string;
  }>;
}

/** Result of the image-verify job (Tier 1 pHash → Tier 2 Vision). */
export interface StagingVerification {
  verifiedAt: string;
  method: "phash-match" | "vision-slab-label" | "vision-tokens" | "user-verified" | "no-image-available" | "no-catalog-reference";
  matched: boolean;                     // true → promote-eligible, false → route to pending-manual
  detail?: string;
  // pHash comparison result when Tier 1 fired.
  phash?: { ingestHash: string; referenceHash: string; distance: number; similarity: number };
  // Vision OCR result when Tier 2 fired.
  vision?: { rawText: string; extractedTokens: string[]; confidence: number };
}

/** Blob mirror result. Populated by the shim before the doc is written. */
export interface StagingMirroredImage {
  blobUrl: string;
  contentHash: string;
  size: number;
  contentType: string;
  mirroredAt: string;
  mirrorError?: {
    reason: "unreachable" | "too-large" | "wrong-type" | "empty" | "write-failed";
    detail?: string;
  };
}

export interface StagingDoc {
  id: string;                            // UUID
  hobbyiqCardId: string;                 // partition key; slug derived from raw payload at write time
  status: StagingStatus;
  observedAt: string;
  raw: StagingRaw;                       // IMMUTABLE
  mirroredImage?: StagingMirroredImage;  // populated once by the shim; not mutated after
  clean?: StagingClean;                  // set by data-clean job
  verification?: StagingVerification;    // set by image-verify job OR manual triage
  promoted?: {
    at: string;
    soldCompsId: string;
    verification: "data-clean" | "image-verified" | "user-verified";
  };
  // Optional per-doc TTL — only set on `pending-manual` if we ever
  // decide those need to age out. Currently null (no-reject rule).
  ttl?: number;
}

let _cached: Container | null = null;
async function getContainer(): Promise<Container | null> {
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

/**
 * Compute the cross-source dedup content hash. Stable subset — a CH
 * report and a CS report of the SAME eBay sale must produce the same
 * hash. Uses (year, cardNumber, parallel, isAuto, price, soldDay).
 * Excludes vendor + vendorRawId so cross-vendor collisions surface.
 */
export function computeStagingContentHash(input: {
  cardYear: number | null | undefined;
  cardNumber: string | null | undefined;
  parallel: string | null | undefined;
  isAuto: boolean;
  price: number;
  soldAt: string;
}): string {
  const parts = [
    String(input.cardYear ?? ""),
    String(input.cardNumber ?? "").toUpperCase(),
    String(input.parallel ?? "").toLowerCase(),
    input.isAuto ? "1" : "0",
    Math.round(input.price * 100).toString(),
    input.soldAt.slice(0, 10),   // day granularity
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * Write a new staging row from raw vendor input. Silent-safe: returns
 * null when Cosmos is unavailable so the caller can fall through to
 * the legacy sold_comps direct-write during rollout.
 */
export async function stageIngestedComp(input: {
  hobbyiqCardId: string;
  raw: StagingRaw;
  mirroredImage?: StagingMirroredImage;
}): Promise<string | null> {
  const c = await getContainer();
  if (!c) return null;
  const doc: StagingDoc = {
    id: randomUUID(),
    hobbyiqCardId: input.hobbyiqCardId,
    status: "pending",
    observedAt: new Date().toISOString(),
    raw: input.raw,
    mirroredImage: input.mirroredImage,
  };
  try {
    await c.items.upsert(doc as unknown as Record<string, unknown>);
    return doc.id;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "comps_staging_write_failed",
      source: "compsStaging.service",
      slug: input.hobbyiqCardId,
      error: (err as Error)?.message ?? String(err),
    }));
    return null;
  }
}

/** Cheap count by status for the data-quality dashboard. */
export async function countByStatus(status: StagingStatus): Promise<number> {
  const c = await getContainer();
  if (!c) return 0;
  try {
    const { resources } = await c.items.query<number>({
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.status = @s",
      parameters: [{ name: "@s", value: status }],
    }).fetchAll();
    return resources[0] ?? 0;
  } catch {
    return 0;
  }
}

// CF-VENDOR-PERSISTENCE-COMMON (Drew, 2026-07-23, issue #722 expansion).
// Shared helpers for every vendor persistence pipeline. Each domain
// (sold_comps, catalog, price series, listings, market signals) has its
// own service that leans on these helpers so the boilerplate stays
// consistent.
//
// Design rules (matches persistVendorSalesToPool):
//   - Fire-and-forget: never fail the caller
//   - Feature-flagged: single env var per domain
//   - Idempotent: contentHash-based dedup
//   - createIfNotExists for the container so ops can flip flags
//     without a manual container-provision step

import { CosmosClient, type Container } from "@azure/cosmos";
import { createHash } from "crypto";

const containerCache = new Map<string, Container>();

/** Get (and lazily create) a Cosmos container by name. Partition key
 *  defaults to /cardId — the shared convention across our persistence
 *  containers. Override when a domain needs a different partition. */
export async function getContainer(
  name: string,
  partitionKey = "/cardId",
): Promise<Container | null> {
  if (containerCache.has(name)) return containerCache.get(name)!;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    const { container } = await db.containers.createIfNotExists({
      id: name,
      partitionKey: { paths: [partitionKey] },
    });
    containerCache.set(name, container);
    return container;
  } catch {
    return null;
  }
}

/** Compute a stable contentHash from any set of stringifiable inputs.
 *  Used across every persistence pipeline for idempotent dedup. */
export function contentHashOf(...parts: unknown[]): string {
  const joined = parts.map((p) => String(p ?? "")).join("|");
  return createHash("sha256").update(joined).digest("hex").slice(0, 32);
}

/** Fire-and-forget wrapper. Silences errors so a persistence failure
 *  never bubbles up to the caller. Every domain persist function should
 *  be invoked through this shim. */
export function runInBackground(fn: () => Promise<void>): void {
  fn().catch((err) => {
    console.warn(JSON.stringify({
      event: "vendor_persistence_background_error",
      source: "vendorPersistenceCommon",
      error: (err as Error)?.message ?? String(err),
    }));
  });
}

/** Structured log helper. Every domain uses the same event shape so
 *  App Insights queries can group across domains. */
export function logPersistEvent(
  domain: string,
  vendorSource: string,
  counts: { inserted: number; deduped: number; skipped: number },
): void {
  if (counts.inserted === 0 && counts.deduped === 0) return;   // silent no-op case
  console.log(JSON.stringify({
    event: "vendor_persistence",
    source: "vendorPersistenceCommon",
    domain,
    vendorSource,
    ...counts,
  }));
}

/** Standard flag check. Each domain has its own env var but the check
 *  shape is identical. */
export function isDomainEnabled(envVar: string): boolean {
  return process.env[envVar] === "true";
}

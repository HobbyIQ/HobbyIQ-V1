#!/usr/bin/env -S node --experimental-strip-types
// CF-VERIFY-CONTAINERS-BOOTSTRAP (Drew, 2026-07-28).
// One-off. Create the verify_queue + verify_corrections Cosmos
// containers with sensible partition keys + indexing.
//
// verify_queue     partition /reason   TTL 60d (per-doc override too)
// verify_corrections  partition /reason  no TTL
//
// Idempotent: skips creation if the container already exists.
//
// Usage:
//   export COSMOS_CONNECTION_STRING="$(az webapp config appsettings list ...)"
//   node --experimental-strip-types backend/scripts/bootstrapVerifyContainers.ts

import { CosmosClient } from "@azure/cosmos";

async function main(): Promise<void> {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");

  for (const spec of [
    { id: "verify_queue", partitionKey: "/reason", defaultTtl: 60 * 24 * 3600 },
    { id: "verify_corrections", partitionKey: "/reason", defaultTtl: -1 },
  ]) {
    try {
      const { resource } = await db.containers.createIfNotExists({
        id: spec.id,
        partitionKey: { paths: [spec.partitionKey] },
        defaultTtl: spec.defaultTtl,
      });
      console.log(`✓ ${resource?.id ?? spec.id}  partition=${spec.partitionKey}  ttl=${spec.defaultTtl}`);
    } catch (err) {
      console.error(`✗ ${spec.id}: ${(err as Error)?.message ?? String(err)}`);
      process.exit(1);
    }
  }
  console.log("\nDone.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

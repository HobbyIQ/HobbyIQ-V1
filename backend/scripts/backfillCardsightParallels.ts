#!/usr/bin/env -S npx tsx
/**
 * CF-PARALLEL-FROM-TITLE backfill (Drew, 2026-07-28).
 *
 * One-off cleanup for sold_comps rows that Cardsight ingest mis-tagged
 * before the CF-PARALLEL-FROM-TITLE fix landed. For every source
 * "cardsight" row in sold_comps, re-parse the sale title's parallel via
 * parseListingIdentity — if it differs from the stored parallel, update
 * the row in place (also recomputes hobbyiqCardId so the slug points
 * at the correct parallel pool).
 *
 * DEFAULT: dry-run. Prints the delta ("would update N rows") + a
 * distribution of before → after parallel changes. Zero writes.
 * Pass --apply to actually mutate rows.
 *
 * SAFETY:
 *   - Only touches rows where source === "cardsight" AND title is present
 *   - Only updates when parseListingIdentity(title).parallel differs
 *   - Also updates hobbyiqCardId (derived from the new parallel)
 *   - Rate-limited: 20 concurrent writes (small in-flight window so we
 *     don't hammer Cosmos throughput on shared containers)
 *
 * Usage:
 *   export COSMOS_CONNECTION_STRING="$(az webapp config appsettings list ...)"
 *   npx tsx backend/scripts/backfillCardsightParallels.ts          # dry-run
 *   npx tsx backend/scripts/backfillCardsightParallels.ts --apply  # writes
 */

import { CosmosClient } from "@azure/cosmos";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

interface Row {
  id: string;
  cardId: string;
  hobbyiqCardId?: string | null;
  playerName?: string | null;
  cardYear?: number | null;
  setName?: string | null;
  cardNumber?: string | null;
  parallel?: string | null;
  isAuto?: boolean | null;
  sport?: string | null;
  title?: string | null;
  source?: string;
  printRun?: number | null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? Infinity);
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("COSMOS_CONNECTION_STRING required");
    process.exit(2);
  }
  console.log(`▸ Mode: ${apply ? "APPLY (WILL WRITE)" : "dry-run"}${limit !== Infinity ? `  limit=${limit}` : ""}`);

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const container = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");

  // Scan all source="cardsight" rows. Cardsight is 470k of ~500k in the
  // pool per the diagnostic — we're reading almost every row. Query in
  // pages of 1000 to keep memory bounded.
  const q = container.items.query<Row>({
    query:
      "SELECT c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.cardYear, c.setName, c.cardNumber, c.parallel, c.isAuto, c.sport, c.title, c.source, c.printRun FROM c WHERE c.source = @s",
    parameters: [{ name: "@s", value: "cardsight" }],
  });

  let scanned = 0;
  let changed = 0;
  let sameParallel = 0;
  let missingTitle = 0;
  let missingContext = 0;
  const flipCounts = new Map<string, number>();
  const pending: Promise<void>[] = [];
  const CONCURRENCY = 20;

  while (q.hasMoreResults()) {
    const { resources } = await q.fetchNext();
    for (const row of resources) {
      if (scanned >= limit) break;
      scanned += 1;
      const title = String(row.title ?? "").trim();
      if (!title) {
        missingTitle += 1;
        continue;
      }
      const parsed = parseListingIdentity(title);
      const storedParallel = String(row.parallel ?? "").trim();
      const newParallel = String(parsed.parallel ?? "").trim();
      if (storedParallel === newParallel) {
        sameParallel += 1;
        continue;
      }
      // Recompute slug with the new parallel. Fall back to skip if
      // required identity is missing (row would need repair anyway).
      if (!row.cardYear || !row.setName || !row.cardNumber || !row.sport) {
        missingContext += 1;
        continue;
      }
      let newSlug: string;
      try {
        newSlug = computeHobbyIqCardId({
          sport: row.sport,
          year: row.cardYear,
          setKey: row.setName,
          cardNumber: row.cardNumber,
          parallel: newParallel || "Base",
          isAuto: row.isAuto ?? parsed.isAuto ?? false,
          printRun: row.printRun ?? parsed.printRun ?? null,
        });
      } catch {
        missingContext += 1;
        continue;
      }

      changed += 1;
      const flipKey = `${storedParallel || "(null)"} → ${newParallel || "Base"}`;
      flipCounts.set(flipKey, (flipCounts.get(flipKey) ?? 0) + 1);

      if (apply) {
        // Patch the two fields. Cosmos patchOperations lets us update
        // in-place without a full doc rewrite.
        const patchP = container.item(row.id, row.cardId).patch([
          { op: "set", path: "/parallel", value: newParallel || "Base" },
          { op: "set", path: "/hobbyiqCardId", value: newSlug },
        ]).then(() => {
          // ok
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`patch failed id=${row.id}: ${msg}`);
        });
        pending.push(patchP);
        if (pending.length >= CONCURRENCY) {
          await Promise.all(pending.splice(0, pending.length));
        }
      }
    }
    if (scanned >= limit) break;
    if (scanned % 5000 === 0) {
      console.log(`  scanned ${scanned}  changed ${changed}  same ${sameParallel}  missing-title ${missingTitle}  missing-ctx ${missingContext}`);
    }
  }
  if (pending.length > 0) await Promise.all(pending);

  console.log(`\n▸ Summary`);
  console.log(`  scanned:          ${scanned}`);
  console.log(`  ${apply ? "updated" : "would update"}:     ${changed}  (${Math.round((changed / Math.max(1, scanned)) * 100)}%)`);
  console.log(`  parallel matches: ${sameParallel}`);
  console.log(`  no title:         ${missingTitle}`);
  console.log(`  missing context:  ${missingContext}`);

  const sortedFlips = Array.from(flipCounts.entries()).sort((a, b) => b[1] - a[1]);
  console.log(`\n▸ Top parallel flips (stored → title-parsed):`);
  for (const [flip, n] of sortedFlips.slice(0, 25)) {
    console.log(`  ${String(n).padStart(6)}  ${flip}`);
  }
  if (sortedFlips.length > 25) {
    console.log(`  ... and ${sortedFlips.length - 25} more distinct flip types`);
  }

  console.log(`\n${apply ? "✓ Wrote changes to Cosmos." : "Dry-run only. Pass --apply to actually update rows."}`);
}

main().catch((err: unknown) => {
  console.error(`fatal:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});

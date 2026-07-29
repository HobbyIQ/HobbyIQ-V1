#!/usr/bin/env -S npx tsx
// CF-VERIFY-QUEUE-SYNC (Drew, 2026-07-28). Bulk cleanup: scans pending
// image-mismatch verify_queue rows, checks if their staging counterpart
// (by cardId + price + soldAt-day) is now `promoted`, and if so marks
// the verify_queue row as `fixed` so it disappears from the UI.
//
// Needed because auto-triage promotes staging rows silently — the
// verify_queue entry stays pending forever otherwise, so Drew's UI
// keeps showing already-resolved items. This script drains the stale
// UI backlog. Future enqueue paths should include stagingId directly
// (follow-up PR).
//
// Idempotent. Dry-run by default; --apply to write.

import { CosmosClient } from "@azure/cosmos";

interface QueueRow {
  id: string;
  reason: string;
  status: string;
  cardId?: string;
  price?: number;
  soldAt?: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? Infinity);
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  console.log(`▸ Mode: ${apply ? "APPLY" : "dry-run"}${limit !== Infinity ? `  limit=${limit}` : ""}`);

  const c = new CosmosClient(conn);
  const db = c.database("hobbyiq");
  const q = db.container("verify_queue");
  const st = db.container("comps_staging");

  const q_iter = q.items.query<QueueRow>({
    query: "SELECT c.id, c.reason, c.status, c.input.cardId, c.input.price, c.input.soldAt FROM c WHERE c.reason = 'image-mismatch' AND c.status = 'pending'",
  });

  let scanned = 0;
  let markedFixed = 0;
  let stillPending = 0;
  let notFound = 0;
  const CONCURRENCY = 15;
  const pending: Promise<void>[] = [];

  const process1 = async (r: QueueRow) => {
    scanned += 1;
    if (!r.cardId) { notFound += 1; return; }
    const soldDay = String(r.soldAt ?? "").slice(0, 10);
    // Find staging row with same slug + price + soldAt day
    const { resources: staged } = await st.items.query({
      query:
        "SELECT TOP 1 c.status FROM c WHERE c.hobbyiqCardId = @slug AND ABS(c.raw.vendorPayload.price - @p) < 0.02 AND STARTSWITH(c.raw.vendorPayload.soldAt, @day)",
      parameters: [
        { name: "@slug", value: r.cardId },
        { name: "@p", value: r.price },
        { name: "@day", value: soldDay },
      ],
    }).fetchAll();
    if (staged.length === 0) { notFound += 1; return; }
    const stagingStatus = (staged[0] as { status: string }).status;
    if (stagingStatus === "promoted") {
      if (apply) {
        await q.item(r.id, r.reason).patch([
          { op: "set", path: "/status", value: "fixed" },
          { op: "set", path: "/resolvedAt", value: new Date().toISOString() },
          { op: "set", path: "/resolvedBy", value: "verify-queue-sync-script" },
        ]).catch(() => { /* silent */ });
      }
      markedFixed += 1;
    } else {
      stillPending += 1;
    }
  };

  while (q_iter.hasMoreResults() && scanned < limit) {
    const { resources } = await q_iter.fetchNext();
    for (const r of resources) {
      if (scanned + pending.length >= limit) break;
      pending.push(process1(r));
      if (pending.length >= CONCURRENCY) await Promise.all(pending.splice(0, pending.length));
    }
    if (scanned >= limit) break;
    if (scanned % 100 === 0) console.log(`  scanned ${scanned}  markedFixed ${markedFixed}  stillPending ${stillPending}  notFound ${notFound}`);
  }
  if (pending.length > 0) await Promise.all(pending);

  console.log(`\n▸ Summary`);
  console.log(`  scanned:        ${scanned}`);
  console.log(`  ${apply ? "marked fixed" : "would mark fixed"}: ${markedFixed}`);
  console.log(`  still pending:  ${stillPending}`);
  console.log(`  not found in staging: ${notFound}`);
  console.log(`\n${apply ? "✓ Wrote to verify_queue." : "Dry-run only. Pass --apply."}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

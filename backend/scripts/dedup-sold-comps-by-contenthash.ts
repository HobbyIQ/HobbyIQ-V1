#!/usr/bin/env -S npx tsx
/**
 * CF-DEDUP-SOLD-COMPS (Drew, 2026-08-06).
 *
 * Retroactive dedup of sold_comps by (hobbyiqCardId, contentHash).
 * Same-contentHash rows in the same partition represent the same
 * physical sale ingested via multiple paths (CardHedge's known
 * multi-path bug pre-9887df07, plus historical slug-variant
 * fragmentation). Verified case: Eric Hartman Orange Shimmer Auto
 * had 10 rows for 4 real sales.
 *
 * Rules:
 *   - Group by (cardId partition, contentHash)
 *   - Within a group with >1 row, keep the highest-scored row per
 *     scoreForCanonical (source-preference + verification flags)
 *   - Delete the others
 *
 * Idempotent — safe re-run. Skips groups that already have exactly
 * one row.
 *
 * Env:
 *   DEDUP_APPLY        true = delete; default dry-run
 *   DEDUP_MAX          safety cap on cardId partitions scanned; default 0 (unbounded)
 *   DEDUP_CONCURRENCY  parallel deletes per group; default 32
 */

import { CosmosClient, type Container } from "@azure/cosmos";

const APPLY = process.env.DEDUP_APPLY === "true";
const MAX = Number(process.env.DEDUP_MAX ?? 0);
const CONCURRENCY = Number(process.env.DEDUP_CONCURRENCY ?? 32);

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const sc: Container = new CosmosClient(conn).database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");

interface Row {
  id: string;
  cardId: string;
  contentHash: string;
  source: string;
  verifiedByUser?: boolean;
  observedAt?: string;
}

// Source preference — matches soldCompsStore.scoreForCanonical intent.
// TCA is preferred (direct eBay firehose), then Cardsight, then
// CardHedge (historical, known dupe emitter), then user contributions.
function scoreForCanonical(r: Row): number {
  let s = 0;
  if (r.verifiedByUser) s += 100;
  const src = String(r.source ?? "").toLowerCase();
  if (src === "tca-ebay") s += 40;
  else if (src === "cardsight") s += 30;
  else if (src === "cardhedge") s += 20;
  else if (src.startsWith("ebay-user")) s += 25;
  else s += 10;
  return s;
}

async function main(): Promise<void> {
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"} — dedup sold_comps by (cardId, contentHash)`);

  // Fetch every row's (id, cardId, contentHash, source, verifiedByUser),
  // group in memory. Cross-partition scan — same-partition rows land
  // in the same bucket via the composite (cardId, contentHash) key.
  const it = sc.items.query<Row>({
    query: `SELECT c.id, c.cardId, c.contentHash, c.source, c.verifiedByUser, c.observedAt
            FROM c WHERE IS_DEFINED(c.contentHash) AND c.contentHash != null
              AND IS_DEFINED(c.cardId) AND c.cardId != null`,
  }, { maxItemCount: 500 });

  const groups = new Map<string, Row[]>();
  let scanned = 0;
  const startedAt = Date.now();

  while (it.hasMoreResults()) {
    let batch: Row[] = [];
    try {
      const { resources } = await it.fetchNext();
      batch = resources;
    } catch (e) {
      console.error(`  ! fetchNext: ${(e as Error).message}`);
      continue;
    }
    for (const r of batch) {
      scanned++;
      const key = `${r.cardId}|${r.contentHash}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(r); else groups.set(key, [r]);
      if (MAX > 0 && scanned >= MAX) break;
    }
    const el = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    process.stderr.write(`  scanning: rows=${scanned.toLocaleString()} groups=${groups.size.toLocaleString()}  ${Math.round(scanned / el)}/s\r`);
    if (MAX > 0 && scanned >= MAX) break;
  }

  console.log(`\n\n▸ Scan complete: ${scanned.toLocaleString()} rows in ${groups.size.toLocaleString()} unique (cardId, contentHash) groups`);

  // Identify dup groups
  const dupGroups: Array<{ key: string; keep: Row; drop: Row[] }> = [];
  for (const [key, rows] of groups) {
    if (rows.length <= 1) continue;
    const sorted = [...rows].sort((a, b) => scoreForCanonical(b) - scoreForCanonical(a));
    dupGroups.push({ key, keep: sorted[0], drop: sorted.slice(1) });
  }
  const dropCount = dupGroups.reduce((s, g) => s + g.drop.length, 0);
  console.log(`▸ Dup groups: ${dupGroups.length.toLocaleString()}`);
  console.log(`▸ Rows to delete: ${dropCount.toLocaleString()}`);
  if (dupGroups.length === 0) return;

  // Sample the top 5 groups
  console.log(`\n▸ Sample of largest dup groups:`);
  const bySize = [...dupGroups].sort((a, b) => b.drop.length - a.drop.length).slice(0, 5);
  for (const g of bySize) {
    console.log(`  ${(g.drop.length + 1)} rows in ${g.key.slice(0, 80)}  keep source=${g.keep.source}`);
  }

  if (!APPLY) {
    console.log(`\n  DRY-RUN — no deletes performed.`);
    return;
  }

  // Delete in parallel batches
  let deleted = 0, errors = 0;
  const deleteStart = Date.now();
  const chunk = <T>(arr: T[], n: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };
  const allDrops = dupGroups.flatMap(g => g.drop);
  for (const batch of chunk(allDrops, CONCURRENCY)) {
    const results = await Promise.allSettled(batch.map(async (r) => {
      await sc.item(r.id, r.cardId).delete();
    }));
    for (const res of results) {
      if (res.status === "fulfilled") deleted++;
      else {
        const msg = (res.reason as Error)?.message ?? String(res.reason);
        if (!/404/.test(msg)) {
          errors++;
          if (errors <= 5) console.error(`  ! delete: ${msg}`);
        }
      }
    }
    const el = Math.max(1, Math.round((Date.now() - deleteStart) / 1000));
    process.stderr.write(`  deleting: ${deleted.toLocaleString()}/${allDrops.length.toLocaleString()} err=${errors}  ${Math.round(deleted / el)}/s\r`);
  }

  console.log(`\n\n▸ Summary`);
  console.log(`  scanned rows:  ${scanned.toLocaleString()}`);
  console.log(`  dup groups:    ${dupGroups.length.toLocaleString()}`);
  console.log(`  deleted rows:  ${deleted.toLocaleString()}`);
  console.log(`  errors:        ${errors}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

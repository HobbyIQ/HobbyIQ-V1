#!/usr/bin/env -S npx tsx
/**
 * CF-NUKE-STAGING-INERT (Drew, 2026-08-06).
 *
 * Deletes ~2.9M inert rows sitting in comps_staging:
 *   - status = "pending"  (~2.0M) — old historical CH bulk-ingest that
 *                                    never got drained; mostly duplicates
 *                                    of rows already in sold_comps.
 *   - status = "anomaly"  (~911K) — flagged as suspicious by the old
 *                                    clean job. Not blocking anything.
 *
 * PRESERVES:
 *   - status = "promoted"      (3.97M) — the successful drain history
 *   - status = "pending-manual"  (15K) — held for admin review, keep
 *
 * Env:
 *   NUKE_APPLY        true = delete; default dry-run
 *   NUKE_STATUSES     default "pending,anomaly"
 *   NUKE_MAX          safety cap per run; default 0 (unbounded)
 *   NUKE_CONCURRENCY  parallel deletes; default 64
 */

import { CosmosClient, type Container } from "@azure/cosmos";

const APPLY = process.env.NUKE_APPLY === "true";
const STATUSES = (process.env.NUKE_STATUSES ?? "pending,anomaly").split(",").map((s) => s.trim()).filter(Boolean);
const MAX = Number(process.env.NUKE_MAX ?? 0);
const CONCURRENCY = Number(process.env.NUKE_CONCURRENCY ?? 64);

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const staging: Container = new CosmosClient(conn).database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("comps_staging");

interface Row {
  id: string;
  cardId?: string;
  status?: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main(): Promise<void> {
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"} — nuke comps_staging rows in status IN (${STATUSES.join(", ")})`);

  const params: Array<{ name: string; value: string }> = STATUSES.map((s, i) => ({ name: `@s${i}`, value: s }));
  const inList = params.map((p) => p.name).join(",");
  const query = `SELECT c.id, c.cardId, c.status FROM c WHERE c.status IN (${inList})`;

  const it = staging.items.query<Row>({ query, parameters: params }, { maxItemCount: 500 });

  let scanned = 0, deleted = 0, errors = 0, notFound = 0;
  const startedAt = Date.now();

  while (it.hasMoreResults()) {
    let batch: Row[] = [];
    try {
      const { resources } = await it.fetchNext();
      batch = resources;
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`  ! fetchNext: ${(e as Error).message}`);
      continue;
    }
    scanned += batch.length;

    if (APPLY) {
      for (const group of chunk(batch, CONCURRENCY)) {
        const results = await Promise.allSettled(group.map(async (r) => {
          const pk = r.cardId ?? r.id;
          await staging.item(r.id, pk).delete();
        }));
        for (const res of results) {
          if (res.status === "fulfilled") deleted++;
          else {
            const msg = (res.reason as Error)?.message ?? String(res.reason);
            if (/404/.test(msg)) notFound++;
            else {
              errors++;
              if (errors <= 5) console.error(`  ! delete: ${msg}`);
            }
          }
        }
      }
    }

    const el = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    process.stderr.write(`  scanned=${scanned.toLocaleString()} deleted=${deleted.toLocaleString()} err=${errors} 404=${notFound}  ${Math.round(scanned / el)}/s scan, ${Math.round(deleted / el)}/s del\r`);
    if (MAX > 0 && scanned >= MAX) break;
  }

  console.log(`\n\n▸ Summary`);
  console.log(`  scanned: ${scanned.toLocaleString()}`);
  console.log(`  deleted: ${deleted.toLocaleString()}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  404s:    ${notFound.toLocaleString()}  (already gone)`);
  console.log(`  errors:  ${errors}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

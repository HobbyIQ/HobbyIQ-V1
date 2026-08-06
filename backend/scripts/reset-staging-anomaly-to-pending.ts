#!/usr/bin/env -S npx tsx
/**
 * CF-RESET-ANOMALY-TO-PENDING (Drew, 2026-08-06).
 *
 * After shipping the CF-ANOMALY-DIRECTION fix (dataCleanJob.service.ts),
 * ~60-70% of the 2.35M rows currently in `status: anomaly` were flagged
 * on false-positive parser-low-confidence detail (title less-specific
 * than slug). Reset them to `pending` so the drainer re-classifies via
 * the corrected logic. Legit anomalies re-flag; false-positives fall
 * through to `clean` and get promoted.
 *
 * The drainer only touches `pending` and `clean/verified` rows — no
 * conflict with this script's `anomaly` writes.
 *
 * Env:
 *   RESET_APPLY       true = write; default dry-run
 *   RESET_CONCURRENCY default 64
 */

import { CosmosClient, type Container } from "@azure/cosmos";

const APPLY = process.env.RESET_APPLY === "true";
const CONCURRENCY = Math.max(1, Math.min(128, Number(process.env.RESET_CONCURRENCY ?? 64)));

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const stage: Container = new CosmosClient(conn)
  .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
  .container("comps_staging");

interface Row { id: string; hobbyiqCardId: string }

async function main(): Promise<void> {
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"} — reset anomaly → pending (concurrency=${CONCURRENCY})`);
  const query = `SELECT c.id, c.hobbyiqCardId FROM c WHERE c.status = "anomaly"`;
  const it = stage.items.query<Row>({ query }, { maxItemCount: 500 });
  let scanned = 0, patched = 0, errors = 0;
  const startedAt = Date.now();
  const now = new Date().toISOString();

  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (resources.length === 0) break;
    scanned += resources.length;

    if (!APPLY) {
      const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      process.stderr.write(`  scanned=${scanned.toLocaleString()}  ${Math.round(scanned / elapsed)}/s\r`);
      continue;
    }

    // Concurrency-limited patch fan-out for this page.
    let inflight = 0;
    let idx = 0;
    await new Promise<void>((resolve) => {
      const kick = (): void => {
        while (inflight < CONCURRENCY && idx < resources.length) {
          const row = resources[idx++];
          inflight++;
          stage.item(row.id, row.hobbyiqCardId).patch({
            operations: [
              { op: "set", path: "/status", value: "pending" },
              { op: "set", path: "/anomalyResetAt", value: now },
            ],
          } as never)
            .then(() => { patched++; })
            .catch((e) => { errors++; if (errors <= 3) console.error(`  ! patch ${row.id}: ${(e as Error).message}`); })
            .finally(() => {
              inflight--;
              if (idx >= resources.length && inflight === 0) resolve();
              else kick();
            });
        }
      };
      kick();
    });

    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    process.stderr.write(`  scanned=${scanned.toLocaleString()} patched=${patched.toLocaleString()} err=${errors}  ${Math.round(patched / elapsed)}/s\r`);
  }

  console.log(`\n\n▸ Summary`);
  console.log(`  scanned:  ${scanned.toLocaleString()}`);
  console.log(`  patched:  ${patched.toLocaleString()}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  errors:   ${errors}`);
  console.log(`  elapsed:  ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });

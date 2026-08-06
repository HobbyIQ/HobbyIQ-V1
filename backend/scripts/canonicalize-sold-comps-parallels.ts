#!/usr/bin/env -S npx tsx
/**
 * CF-PARALLEL-CANONICAL (Drew, 2026-08-06). Retroactive parallel-name
 * canonicalization for sold_comps.
 *
 * Reads every sold_comps row, runs `parallel` through
 * canonicalizeParallel(), patches when the canonical differs from what's
 * stored. Also fills the new `parallelSlug` field on legacy rows.
 *
 * This is the second half of the CF-PARALLEL-CANONICAL push — the
 * ingest-time canonicalization ships alongside soldCompsStore, so new
 * rows land canonical. This script fixes the ~1M+ existing rows that
 * were stored with the raw vendor spelling.
 *
 * Idempotent + resumable — the guard skips rows whose current
 * (parallel, parallelSlug) already matches what the canonicalizer
 * would produce.
 *
 * Env:
 *   PARALLEL_APPLY   true = write; default dry-run
 *   PARALLEL_MAX     safety cap on rows scanned; default 0 (unbounded)
 *   PARALLEL_SOURCE  optional source filter (cardhedge | tca-ebay | ...)
 */

import { CosmosClient, Container } from "@azure/cosmos";
import { canonicalizeParallel } from "../src/services/portfolioiq/parallelCanonicalizer.service.js";

const APPLY = process.env.PARALLEL_APPLY === "true";
const MAX = Number(process.env.PARALLEL_MAX ?? 0);
const SOURCE = process.env.PARALLEL_SOURCE ?? "";

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const sc: Container = new CosmosClient(conn).database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");

interface Row {
  id: string;
  cardId: string;
  parallel: string | null;
  parallelSlug?: string | null;
}

async function main(): Promise<void> {
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"} — canonicalize sold_comps parallels`);
  if (SOURCE) console.log(`  source filter: ${SOURCE}`);
  if (MAX) console.log(`  cap: ${MAX.toLocaleString()} rows`);

  const params: Array<{ name: string; value: string }> = [];
  const where: string[] = ["IS_DEFINED(c.parallel)"];
  if (SOURCE) {
    where.push("c.source = @src");
    params.push({ name: "@src", value: SOURCE });
  }
  const q = `SELECT c.id, c.cardId, c.parallel, c.parallelSlug
             FROM c WHERE ${where.join(" AND ")}`;

  const it = sc.items.query<Row>({ query: q, parameters: params }, { maxItemCount: 500 });

  let scanned = 0, changed = 0, patched = 0, unchanged = 0, errors = 0, nullOut = 0;
  const rewriteCounts = new Map<string, number>();
  const startedAt = Date.now();

  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      scanned++;
      const canonical = canonicalizeParallel(r.parallel);
      const newDisplay = canonical?.display ?? null;
      const newSlug = canonical?.slug ?? null;

      const displayChanged = (r.parallel ?? null) !== newDisplay;
      const slugChanged = (r.parallelSlug ?? null) !== newSlug;
      if (!displayChanged && !slugChanged) { unchanged++; continue; }
      changed++;
      if (newDisplay === null) nullOut++;

      // Track top rewrites so the dry-run summary shows what actually changed.
      if (displayChanged) {
        const key = `${JSON.stringify(r.parallel)} → ${JSON.stringify(newDisplay)}`;
        rewriteCounts.set(key, (rewriteCounts.get(key) ?? 0) + 1);
      }

      if (!APPLY) continue;
      try {
        const ops: Array<Record<string, unknown>> = [];
        if (displayChanged) ops.push({ op: "set", path: "/parallel", value: newDisplay });
        if (slugChanged) ops.push({ op: "set", path: "/parallelSlug", value: newSlug });
        ops.push({ op: "set", path: "/parallelCanonicalizedAt", value: new Date().toISOString() });
        await sc.item(r.id, r.cardId).patch({ operations: ops } as never);
        patched++;
      } catch (e) {
        errors++;
        if (errors <= 5) console.error(`  ! patch ${r.id}: ${(e as Error).message}`);
      }
      if (MAX > 0 && scanned >= MAX) break;
    }
    if (scanned % 5000 < 500) {
      const el = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      process.stderr.write(`  scanned=${scanned.toLocaleString()} changed=${changed.toLocaleString()} patched=${patched.toLocaleString()} err=${errors}  ${Math.round(scanned / el)}/s\r`);
    }
    if (MAX > 0 && scanned >= MAX) break;
  }

  console.log(`\n\n▸ Summary`);
  console.log(`  scanned:   ${scanned.toLocaleString()}`);
  console.log(`  unchanged: ${unchanged.toLocaleString()}`);
  console.log(`  changed:   ${changed.toLocaleString()}`);
  console.log(`  patched:   ${patched.toLocaleString()}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  null-out:  ${nullOut.toLocaleString()}  (parallel canonicalized to null — likely garbage strings)`);
  console.log(`  errors:    ${errors}`);

  console.log(`\n▸ Top 15 display rewrites`);
  const top = [...rewriteCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [k, n] of top) console.log(`  ${String(n).padStart(7)}  ${k}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

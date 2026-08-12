#!/usr/bin/env -S npx tsx
/**
 * CF-GHOST-GRADE-VALUE-SWEEP (Drew, 2026-08-06).
 *
 * Pool-wide sweep: find every sold_comps row where gradeCompany is set
 * but gradeValue is null (ingested pre-title-extract-guard). Extract
 * the grade from the row's title regex and patch. Ghost rows show up as
 * phantom "PSA" / "BGS" tiles on the grade curve UI, adjacent to the
 * real PSA 9 / PSA 10 tiles for the same card.
 *
 * Env:
 *   GHOST_APPLY   true = write; default dry-run
 *   GHOST_MAX     safety cap on rows scanned; default 0 (unbounded)
 */

import { CosmosClient, type Container } from "@azure/cosmos";

const APPLY = process.env.GHOST_APPLY === "true";
const MAX = Number(process.env.GHOST_MAX ?? 0);
const CONCURRENCY = Number(process.env.GHOST_CONCURRENCY ?? 32);

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const sc: Container = new CosmosClient(conn).database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");

const RE = /\b(PSA|BGS|SGC|CGC|CSG|HGA)\s+(10(?:\.0)?|9\.5|9|8\.5|8|7|6|5|4|3|2|1)\b/i;

interface Row {
  id: string;
  cardId: string;
  gradeCompany: string;
  title: string | null;
}

async function main(): Promise<void> {
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"} — sweep ghost-grade rows`);
  const it = sc.items.query<Row>({
    query: `SELECT c.id, c.cardId, c.gradeCompany, c.title
            FROM c WHERE IS_DEFINED(c.gradeCompany) AND c.gradeCompany != null
              AND (c.gradeValue = null OR NOT IS_DEFINED(c.gradeValue))
              AND IS_DEFINED(c.title) AND c.title != null`,
  }, { maxItemCount: 500 });

  let scanned = 0, matched = 0, patched = 0, unmatched = 0, errors = 0;
  const start = Date.now();
  const chunkArr = <T>(arr: T[], n: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };

  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    const patches: Array<{ r: Row; co: string; val: number }> = [];
    for (const r of resources) {
      scanned++;
      const m = String(r.title ?? "").toUpperCase().match(RE);
      if (!m) { unmatched++; continue; }
      const co = m[1];
      const val = Number(m[2]);
      if (!Number.isFinite(val)) { unmatched++; continue; }
      matched++;
      patches.push({ r, co, val });
      if (MAX > 0 && scanned >= MAX) break;
    }
    if (APPLY && patches.length > 0) {
      for (const batch of chunkArr(patches, CONCURRENCY)) {
        const results = await Promise.allSettled(batch.map(async ({ r, co, val }) => {
          await sc.item(r.id, r.cardId).patch({
            operations: [
              { op: "set", path: "/gradeCompany", value: co },
              { op: "set", path: "/gradeValue", value: val },
              { op: "set", path: "/gradeExtractedFromTitleAt", value: new Date().toISOString() },
            ],
          } as never);
        }));
        for (const res of results) {
          if (res.status === "fulfilled") patched++;
          else { errors++; if (errors <= 3) console.error("  ! patch failed:", (res.reason as Error).message); }
        }
      }
    }
    const el = Math.max(1, Math.round((Date.now() - start) / 1000));
    process.stderr.write(`  scanned=${scanned.toLocaleString()} matched=${matched.toLocaleString()} patched=${patched.toLocaleString()} unmatched=${unmatched} err=${errors}  ${Math.round(scanned / el)}/s\r`);
    if (MAX > 0 && scanned >= MAX) break;
  }

  console.log(`\n\n▸ Summary`);
  console.log(`  scanned:   ${scanned.toLocaleString()}`);
  console.log(`  matched:   ${matched.toLocaleString()}  (title yielded grade)`);
  console.log(`  patched:   ${patched.toLocaleString()}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  unmatched: ${unmatched.toLocaleString()}  (no title grade token — needs OCR path)`);
  console.log(`  errors:    ${errors}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// CF-BACKFILL-VERIFY-QUEUE-GRADES (Drew, 2026-07-29). Backfill for
// PR #928 (grade extraction) + PR #937 (PSA MINT modifier). Existing
// verify_queue entries carry input.gradeCompany/gradeValue that were
// populated at enqueue time — often BEFORE the grade parser fixes
// shipped. As a result, the triage UI still shows Grade=Raw even though
// the title clearly has "PSA MINT 9" or "PSA 8.5+".
//
// Fix: scan pending verify_queue rows where input.gradeCompany is null
// OR the current parseGradeLabel yields a different result, and patch
// input.gradeCompany + input.gradeValue.
//
// Env:
//   COSMOS_CONNECTION_STRING — required
//   BACKFILL_APPLY=true       — actually write (default dry-run)
//   BACKFILL_CONCURRENCY=16   — parallel patches

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { parseGradeLabel } = require(path.join(backend, "dist/services/portfolioiq/gradeParser.js"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "16");

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0, ok = 0, err = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx]); ok++; }
      catch { err++; }
    }
  });
  await Promise.all(workers);
  return { ok, err };
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const q = client.database("hobbyiq").container("verify_queue");

  console.log(`[backfill-verify-queue-grades] scanning pending rows...`);
  console.log(`  apply: ${APPLY} (set BACKFILL_APPLY=true to write)`);
  console.log(`  concurrency: ${CONCURRENCY}`);

  // Fetch all pending rows with a title
  const query = `
    SELECT c.id, c.reason, c.input.title, c.input.gradeCompany, c.input.gradeValue
    FROM c
    WHERE c.status = 'pending' AND IS_DEFINED(c.input.title)
  `;
  const it = q.items.query({ query }, { maxItemCount: 5000 });
  const candidates = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) candidates.push(...resources);
    process.stdout.write(`\r  scanned ${candidates.length}`);
  }
  console.log(`\n  ${candidates.length} pending rows with titles\n`);

  const patches = [];
  let alreadyCorrect = 0, noGradeInTitle = 0;

  for (const r of candidates) {
    const title = String(r.title || "");
    if (!title) continue;
    const parsed = parseGradeLabel(title);
    if (!parsed) { noGradeInTitle++; continue; }

    const currentCompany = r.gradeCompany ?? null;
    const currentValue = r.gradeValue ?? null;
    if (currentCompany === parsed.gradeCompany && Number(currentValue) === Number(parsed.gradeValue)) {
      alreadyCorrect++;
      continue;
    }
    patches.push({
      id: r.id,
      partitionKey: r.reason,   // verify_queue partitioned by reason
      title,
      newCompany: parsed.gradeCompany,
      newValue: parsed.gradeValue,
      oldCompany: currentCompany,
      oldValue: currentValue,
    });
  }

  console.log(`No grade in title:         ${noGradeInTitle}`);
  console.log(`Already correct:           ${alreadyCorrect}`);
  console.log(`Ready to backfill:         ${patches.length}\n`);

  if (patches.length === 0) return;

  console.log("Sample 20 (old → new):");
  patches.slice(0, 20).forEach(p => {
    const old = p.oldCompany ? `${p.oldCompany} ${p.oldValue}` : "null";
    console.log(`  ${old} → ${p.newCompany} ${p.newValue}   [${p.title.slice(0, 60)}]`);
  });

  if (!APPLY) {
    console.log(`\n*** DRY-RUN. Set BACKFILL_APPLY=true to write. ***`);
    return;
  }

  console.log(`\nApplying ${patches.length} patches at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(patches, async (p) => {
    await q.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/input/gradeCompany", value: p.newCompany },
      { op: "set", path: "/input/gradeValue", value: p.newValue },
    ]);
    done++;
    if (done % 500 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  applied ${done}/${patches.length} (${rate}/s)`);
    }
  });
  console.log(`\n  applied ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });

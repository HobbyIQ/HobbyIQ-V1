#!/usr/bin/env node
// CF-APPROVE-TOPPS-FINEST-2026 (Drew, 2026-07-29). Batch-approve all
// pending verify_queue rows for 2026 Topps Finest. New product, no
// reference image exists yet, so image-verify routes every row to
// manual triage — Drew reviewed and confirmed the whole batch is
// legitimate.
//
// Each approved row is promoted into sold_comps with
// verifiedByUser=true via the standard resolveQueued path, so the
// downstream reprice/FMV compute picks them up on next refresh.
//
// Env:
//   COSMOS_CONNECTION_STRING — required
//   APPROVE_APPLY=true        — actually approve (default dry-run)
//   APPROVE_CONCURRENCY=8     — parallel approvals (kept modest because
//                                each write touches TWO containers:
//                                verify_queue update + sold_comps insert)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { resolveQueued } = require(path.join(backend, "dist/services/portfolioiq/verifyQueue.service.js"));

const APPLY = process.env.APPROVE_APPLY === "true";
const CONCURRENCY = Number(process.env.APPROVE_CONCURRENCY || "8");
const ADMIN_USER_ID = "batch-topps-finest-2026-2026-07-29";

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0, ok = 0, err = 0, alreadyResolved = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        const r = await worker(items[idx]);
        if (r?.ok) ok++;
        else if (r?.reason?.startsWith("already-resolved")) alreadyResolved++;
        else err++;
      } catch { err++; }
    }
  });
  await Promise.all(workers);
  return { ok, err, alreadyResolved };
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const q = client.database("hobbyiq").container("verify_queue");

  console.log(`[approve-topps-finest-2026]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);

  // Scan pending rows. Filter to 2026 Topps Finest by title/setName.
  const query = `
    SELECT c.id, c.reason, c.status, c.input.title, c.input.setName,
           c.input.cardYear, c.input.gradeCompany, c.input.gradeValue,
           c.input.price, c.observedAt
    FROM c
    WHERE c.status = "pending"
      AND c.input.cardYear = 2026
      AND (
        CONTAINS(LOWER(c.input.title), "topps finest")
        OR CONTAINS(LOWER(c.input.setName), "topps finest")
        OR CONTAINS(LOWER(c.input.setName), "finest")
      )
  `;
  const it = q.items.query({ query }, { maxItemCount: 5000 });
  const candidates = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) candidates.push(...resources);
    process.stdout.write(`\r  scanned ${candidates.length}`);
  }
  console.log(`\n  ${candidates.length} pending 2026 Topps Finest rows\n`);

  if (candidates.length === 0) {
    console.log("  Nothing to approve.");
    return;
  }

  // Breakdown by reason (mostly image-mismatch expected).
  const reasonCounts = {};
  for (const r of candidates) {
    reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
  }
  console.log(`  By reason:`);
  Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`    ${k.padEnd(28)} ${v}`));

  console.log(`\n  Sample 10 titles (with price + grade):`);
  candidates.slice(0, 10).forEach(r => {
    const g = r.gradeCompany ? `${r.gradeCompany} ${r.gradeValue}` : "raw";
    const price = r.price != null ? `$${r.price}` : "?";
    console.log(`    [${g.padEnd(10)}] ${price.padStart(6)}  ${String(r.title || "").slice(0, 80)}`);
  });

  if (!APPLY) {
    console.log(`\n*** DRY-RUN. Set APPROVE_APPLY=true to promote all ${candidates.length} rows. ***`);
    return;
  }

  console.log(`\n  Approving ${candidates.length} rows at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(candidates, async (r) => {
    const res = await resolveQueued(r.id, r.reason, "approve", {
      adminUserId: ADMIN_USER_ID,
    });
    done++;
    if (done % 100 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  approved ${done}/${candidates.length} (${rate}/s)`);
    }
    return res;
  });
  console.log(
    `\n  approved ${result.ok} / already-resolved ${result.alreadyResolved} / errors ${result.err} in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}

main().catch(e => { console.error(e); process.exit(1); });

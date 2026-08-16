#!/usr/bin/env node
/**
 * CF-AUTHENTIC-BUCKET (Drew, 2026-08-15: "fix those cards and do it going
 * forward"). The parser fix handles new ingests; this re-tags the rows
 * already in the pool.
 *
 * An authenticated-but-ungraded slab is neither raw nor a numeric tier, and
 * it trades well BELOW the same card raw. Before the parser fix these rows
 * landed in one of two wrong places depending on the code path:
 *
 *   gradeCompany null, gradeValue null   -> counted as RAW
 *   gradeCompany CGC,  gradeValue 1      -> a phantom "CGC 1" tier, because
 *                                           the parser read the CARD NUMBER
 *                                           "#1" as the grade
 *
 * Observed on 2018 Bowman Chrome Ohtani #1: two "CGC AUTH" sales at $1,680
 * and $1,770 sat in the raw pool against genuine raw sales at $3,000-3,049,
 * dragging the raw median to $2,900 and setting the low.
 *
 * SAFETY. Only writes on a POSITIVE verdict from the shipped parser — the
 * same code path new ingests use, so remediated rows and future rows agree.
 * A row the parser declines is left exactly as it is. Nothing is deleted.
 *
 * The Raw filter selects on gradeCompany/gradeValue (readCompsByCardId), not
 * on the slug, so patching those fields is what moves a row out of the raw
 * pool. gradeValue 0 is deliberate: CF-GRADE-VALUE-NULL-REJECT in
 * soldCompsStore coerces "company set + value null" back to raw, so a null
 * here would silently undo the fix.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/repair-authentic-grade-bucket.cjs [--apply] [--concurrency=16]
 *
 * Defaults to DRY-RUN.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const { parseGradeLabel } = require(path.join(backend, "dist/services/portfolioiq/gradeParser.js"));
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  const APPLY = has("apply");
  const CONCURRENCY = Math.max(1, Number(arg("concurrency", "16")));
  console.log(`[authentic-repair] mode=${APPLY ? "APPLY" : "DRY-RUN"} concurrency=${CONCURRENCY}`);

  // Substring prefilter only — the PARSER decides. CONTAINS is not
  // word-boundary aware, so this deliberately over-selects ("AUTHORIZED",
  // "AUTOGRAPH") and lets the shipped parser reject the noise.
  const iter = sold.items.query({
    query: `SELECT c.id, c.cardId, c.title, c.gradeCompany, c.gradeValue, c.isAuthentic, c.price
            FROM c
            WHERE CONTAINS(UPPER(c.title), 'AUTH')`,
  }, { maxItemCount: 500 });

  const tot = { scanned: 0, authentic: 0, alreadyCorrect: 0, wasRaw: 0, wasNumeric: 0, written: 0, failed: 0, declined: 0 };
  const byCompany = {};
  const samples = [];
  const inflight = new Set();

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const row of resources || []) {
      tot.scanned++;
      const title = String(row.title ?? "").trim();
      if (!title) { tot.declined++; continue; }

      let parsed;
      try { parsed = parseGradeLabel(title); } catch { tot.declined++; continue; }
      if (!parsed || parsed.isAuthentic !== true) { tot.declined++; continue; }

      tot.authentic++;
      byCompany[parsed.gradeCompany] = (byCompany[parsed.gradeCompany] || 0) + 1;

      if (row.isAuthentic === true && row.gradeValue === 0 && row.gradeCompany === parsed.gradeCompany) {
        tot.alreadyCorrect++;
        continue;
      }
      if (row.gradeCompany == null && row.gradeValue == null) tot.wasRaw++;
      else tot.wasNumeric++;

      if (samples.length < 10) {
        samples.push(`${String(row.gradeCompany ?? "raw").padEnd(7)}${String(row.gradeValue ?? "-").padEnd(5)} -> ${parsed.gradeCompany} Authentic   $${String(row.price).padEnd(9)}${title.slice(0, 56)}`);
      }
      if (!APPLY) continue;

      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      // sold_comps is partitioned by /cardId, NOT by doc id.
      const p = sold.item(row.id, row.cardId).patch([
        { op: "add", path: "/gradeCompany", value: parsed.gradeCompany },
        { op: "add", path: "/gradeValue", value: 0 },
        { op: "add", path: "/isAuthentic", value: true },
        { op: "add", path: "/gradeRepairedAt", value: new Date().toISOString() },
      ])
        .then(() => { tot.written++; })
        .catch((e) => {
          tot.failed++;
          if (tot.failed <= 5) console.warn(`  patch failed id=${row.id} pk=${row.cardId}: ${e.code ?? e.message}`);
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }
    process.stderr.write(`\rscanned=${tot.scanned} authentic=${tot.authentic} written=${tot.written}`);
  }
  while (inflight.size) await Promise.race([...inflight]);
  process.stderr.write("\n");

  console.log(`\n  scanned (title contains AUTH)  ${tot.scanned}`);
  console.log(`  parser says Authentic          ${tot.authentic}`);
  console.log(`    already correct              ${tot.alreadyCorrect}`);
  console.log(`    was counted RAW              ${tot.wasRaw}`);
  console.log(`    was a numeric tier           ${tot.wasNumeric}`);
  console.log(`  parser declined (left alone)   ${tot.declined}`);
  console.log(`  written                        ${APPLY ? `${tot.written} (failed ${tot.failed})` : "(dry-run)"}`);
  console.log("\n  by grading company:");
  for (const [k, v] of Object.entries(byCompany).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(6)}  ${k}`);
  }
  console.log("\n  sample re-tags:");
  for (const s of samples) console.log(`    ${s}`);
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });

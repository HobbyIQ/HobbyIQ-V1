#!/usr/bin/env node
/**
 * CF-GRADE-VALUE-STRING (Drew, 2026-08-15: "fix those").
 *
 * gradeValue is typed number|null, but callers reach the store through
 * untyped vendor payloads and 68,410 rows landed with a STRING — 68,284 of
 * them from cardsight, 126 from tca-ebay.
 *
 * Cosmos does not coerce types in a predicate, so `WHERE c.gradeValue = 10`
 * never matches the string "10". Measured:
 *
 *     514,015  PSA gradeValue = 10    (number)   visible to the PSA 10 pool
 *      24,444  PSA gradeValue = "10"  (string)   INVISIBLE to it
 *
 * So a fifth of the PSA 10 sales for the whole pool were missing from their
 * own comp tier — a silent, uneven hole rather than an obvious failure.
 *
 * Two conversions, from the 22 distinct string values observed:
 *
 *   "1".."10" (19 values)      -> the number
 *   "AU" / "A" / "Authentic"   -> the Authentic bucket (gradeValue 0,
 *                                 isAuthentic true). These are not grades;
 *                                 they are the authentication designation,
 *                                 and dropping them to null would push an
 *                                 authenticated slab back into the raw pool.
 *
 * SAFETY. Only rows whose gradeValue is genuinely a string are touched, and
 * only when the value is one of the 22 known forms. Anything else is left
 * exactly as it is. The going-forward guard lives in recordSoldComp so this
 * cannot re-accumulate.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/repair-string-grade-values.cjs [--apply] [--concurrency=16]
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
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  const APPLY = has("apply");
  const CONCURRENCY = Math.max(1, Number(arg("concurrency", "16")));
  console.log(`[grade-string-repair] mode=${APPLY ? "APPLY" : "DRY-RUN"} concurrency=${CONCURRENCY}`);

  const iter = sold.items.query({
    query: `SELECT c.id, c.cardId, c.gradeCompany, c.gradeValue
            FROM c WHERE IS_STRING(c.gradeValue)`,
  }, { maxItemCount: 500 });

  const tot = { scanned: 0, toNumber: 0, toAuthentic: 0, unrecognized: 0, written: 0, failed: 0 };
  const byValue = {};
  const inflight = new Set();

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const row of resources || []) {
      tot.scanned++;
      const raw = String(row.gradeValue).trim();
      byValue[raw] = (byValue[raw] || 0) + 1;

      let ops = null;
      if (/^(?:au|a|authentic)$/i.test(raw)) {
        tot.toAuthentic++;
        ops = [
          { op: "add", path: "/gradeValue", value: 0 },
          { op: "add", path: "/isAuthentic", value: true },
        ];
      } else {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0 && n <= 10) {
          tot.toNumber++;
          ops = [{ op: "add", path: "/gradeValue", value: n }];
        } else {
          tot.unrecognized++;   // left untouched on purpose
          continue;
        }
      }
      if (!APPLY) continue;

      ops.push({ op: "add", path: "/gradeTypeRepairedAt", value: new Date().toISOString() });
      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      // sold_comps is partitioned by /cardId, NOT by doc id.
      const p = sold.item(row.id, row.cardId).patch(ops)
        .then(() => { tot.written++; })
        .catch((e) => {
          tot.failed++;
          if (tot.failed <= 5) console.warn(`  patch failed id=${row.id} pk=${row.cardId}: ${e.code ?? e.message}`);
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }
    process.stderr.write(`\rscanned=${tot.scanned} written=${tot.written}`);
  }
  while (inflight.size) await Promise.race([...inflight]);
  process.stderr.write("\n");

  console.log(`\n  rows with a STRING gradeValue  ${tot.scanned}`);
  console.log(`    -> numeric grade             ${tot.toNumber}`);
  console.log(`    -> Authentic bucket          ${tot.toAuthentic}`);
  console.log(`    unrecognized, left alone     ${tot.unrecognized}`);
  console.log(`  written                        ${APPLY ? `${tot.written} (failed ${tot.failed})` : "(dry-run)"}`);
  console.log("\n  by stored value:");
  for (const [k, v] of Object.entries(byValue).sort((a, b) => b[1] - a[1]).slice(0, 24)) {
    console.log(`    ${String(v).padStart(6)}  "${k}"`);
  }
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });

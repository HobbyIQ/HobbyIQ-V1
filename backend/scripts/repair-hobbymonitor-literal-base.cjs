#!/usr/bin/env node
/**
 * CF-BLANK-MEANS-UNKNOWN-NEVER-BASE, applied to the rows already stored.
 *
 * #1634 fixed the EMITTER: fetchHobbyMonitorChecklist emitted
 * `parallel: cat === "base" ? "Base" : ""`, writing the literal word "Base"
 * into the parallel column of every base card of every hobbymonitor release.
 * The source never said it — hobbymonitor states a finish once per subset on
 * the ladder (cardParallels[]) and never on a card object. The word was ours.
 *
 * A fixed emitter does not fix a stored row, and re-running the ingest does
 * not either: upsertCatalogEntry only writes a field when the new value
 * IMPROVES on the stored one, and "" does not improve on "Base". So the rows
 * already ingested keep asserting a finish their source never stated. This
 * script is the other half of #1634.
 *
 * WHAT THIS IS NOT: a re-key, or a pool movement.
 *
 * The base tier is expressed by the SLUG, not by a word in the stored field,
 * and the slug is already blank-equivalent. Verified 2026-09-01 by running
 * the real buildComponents + computeHobbyIqCardId over every spelling:
 *
 *     ""        -> hiq:baseball:2026:panini-prizm:1:base:no-auto
 *     "Base"    -> hiq:baseball:2026:panini-prizm:1:base:no-auto
 *     null      -> hiq:baseball:2026:panini-prizm:1:base:no-auto
 *     " Base "  -> hiq:baseball:2026:panini-prizm:1:base:no-auto
 *   ( "Silver Prizm" -> ...:silver-prizm:no-auto, for contrast )
 *
 * So blanking the field cannot move a card onto a different slug, cannot
 * split a pool, and cannot change an FMV. It corrects what the row ASSERTS.
 * That is why this is a FIELD PATCH through patchCatalogRowFields and never
 * moveCatalogRow — and why a raw container.patch() is not allowed here
 * (CF-GUARD-THE-CATALOG-WRITE-CONTRACT). The helper keeps /parallelBefore,
 * so every write is reversible.
 *
 * SCOPE — the six audited groups, 1,075 rows (measured 2026-09-01):
 *
 *     panini-prizm          2026    579
 *     topps-cosmic-chrome   2025    204
 *     topps-resurgence      2025    106
 *     panini-turn-four      2026    100
 *     panini-obsidian       2025     44
 *     panini-immaculate     2026     42
 *
 * NARROW BY CONSTRUCTION, on three axes at once. A row is touched only if:
 *   - its (setKey, cardYear) is one of the SIX groups above — a seventh
 *     group is refused, never silently swept;
 *   - its `source` is a hobbymonitor source; and
 *   - its stored parallel is the LITERAL word "Base" (case/space-insensitive).
 *     A real parallel name — "Silver Prizm", "Orange Refractor" — is left
 *     alone. Only the word we invented is removed.
 *
 * A ROW MUST SATISFY ALL THREE. Any one of them alone would be a sweep.
 *
 * ON THE SOURCE FILTER: hobbymonitor rows do NOT all carry the bare string.
 * ingest-universe-driver mints `<lane>-<YYYY-MM-DD>` (e.g.
 * `hobbymonitor-2026-09-01`), so each nightly run stamps a NEW source and an
 * exact-equality filter decays to nothing. The filter is therefore a PREFIX,
 * which is what "source hobbymonitor only" means in practice — and the prefix
 * is anchored, so it can never reach another publisher's rows.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/repair-hobbymonitor-literal-base.cjs \
 *     --source=hobbymonitor [--expect=1075] [--apply]
 *
 * Runner: script=repair-hobbymonitor-literal-base, sources=hobbymonitor.
 * Defaults to DRY-RUN (report-first). SOURCE is REQUIRED and must be a
 * hobbymonitor scope — the script refuses to run at any wider one
 * (CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME).
 */

const path = require("path");
const backend = path.join(__dirname, "..");

const arg = (n, d = "") => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
// CF-ENV-VAR-TRIM-SYMMETRY: trim BOTH reads.
const env = (n, d = "") => String(process.env[n] ?? "").trim() || d;
const flag = (n) => process.argv.includes(`--${n}`);
const num = (n) => Number(n).toLocaleString("en-US");

// CF-THE-RUNNER-EXPORTS-BACKFILL-APPLY-NOT-APPLY. The runner sets
// BACKFILL_APPLY; a direct run uses --apply.
const APPLY = flag("apply") || env("BACKFILL_APPLY") === "true";

// The runner carries this on its `sources` input.
const SOURCE = arg("source", env("SOURCE") || env("SOURCES"));
const EXPECT = arg("expect", "");
const CONCURRENCY = Math.max(1, Number(arg("concurrency", env("BACKFILL_CONCURRENCY", "8"))) || 8);

/**
 * THE SIX AUDITED GROUPS. This list IS the scope: it is not a default that a
 * flag can widen, and there is no "all groups" switch. A group that is not
 * named here is not repaired by this script — the audit that produced these
 * counts is what makes the write safe, and an unaudited group has no such
 * evidence behind it.
 */
const GROUPS = [
  { setKey: "panini-prizm", cardYear: 2026, expect: 579 },
  { setKey: "topps-cosmic-chrome", cardYear: 2025, expect: 204 },
  { setKey: "topps-resurgence", cardYear: 2025, expect: 106 },
  { setKey: "panini-turn-four", cardYear: 2026, expect: 100 },
  { setKey: "panini-obsidian", cardYear: 2025, expect: 44 },
  { setKey: "panini-immaculate", cardYear: 2026, expect: 42 },
];
const TOTAL_EXPECT = GROUPS.reduce((a, g) => a + g.expect, 0); // 1075

/** The source scope this script will accept. Anchored: `hobbymonitor` and its
 *  dated runs, never another publisher whose name merely contains it. */
const SOURCE_ROOT = "hobbymonitor";
function isHobbyMonitorScope(s) {
  return String(s ?? "").trim().toLowerCase() === SOURCE_ROOT;
}

/**
 * THE ONE VALUE THIS SCRIPT REMOVES. The literal word we invented, in any
 * casing or padding. Everything else — a real rung name — is left alone.
 * Exported for the tests, so the guard that runs is the guard that is pinned.
 */
function isLiteralBase(parallel) {
  return /^\s*base\s*$/i.test(String(parallel ?? ""));
}

/** A row is in scope only if all three axes agree. */
function inScope(row) {
  if (!row) return false;
  if (!isLiteralBase(row.parallel)) return false;
  if (!String(row.source ?? "").toLowerCase().startsWith(SOURCE_ROOT)) return false;
  return GROUPS.some((g) => g.setKey === row.setKey && g.cardYear === Number(row.cardYear));
}

/** Bounded worker pool. Returns when every task has settled. */
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; await fn(items[k]); }
    }),
  );
}

async function main() {
  // REFUSALS BEFORE REQUIRES, so a missing dist/ can never be mistaken for a
  // refusal (and a refusal is never mistaken for a crash).
  if (!SOURCE) {
    console.error('FATAL: --source (runner: sources) is required, and must be "hobbymonitor".');
    console.error("       This repair exists because ONE fetcher wrote a word its source never said.");
    console.error("       It refuses to run at any wider source scope.");
    process.exit(2);
  }
  if (!isHobbyMonitorScope(SOURCE)) {
    console.error(`FATAL: --source=${JSON.stringify(SOURCE)} is not the hobbymonitor scope.`);
    console.error(`       Only ${JSON.stringify(SOURCE_ROOT)} is accepted. Another publisher's`);
    console.error("       base rows are not this defect and must not be blanked with it.");
    process.exit(2);
  }
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }

  const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
  // The row-op, not a hand-rolled patch: CF-GUARD-THE-CATALOG-WRITE-CONTRACT.
  const { patchCatalogRowFields } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");

  console.log(`[repair-hobbymonitor-literal-base] mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  source:  ${SOURCE_ROOT}* (prefix — dated runs mint a new stamp nightly)`);
  console.log(`  removes: the literal word "Base" from the parallel FIELD; blank means unknown`);
  console.log(`  identity: UNCHANGED — "" and "Base" normalize to the same slug (verified #1634)`);
  console.log(`  groups:  ${GROUPS.length}, ${num(TOTAL_EXPECT)} rows expected\n`);

  // One query per group. Six small, fully-parameterised, three-axis queries
  // beat one wide one: each is bounded by its own audited count, and a group
  // that comes back the wrong size is named in the refusal.
  const found = [];
  const perGroup = [];
  for (const g of GROUPS) {
    const { resources } = await cat.items.query(
      {
        query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.setKey, c.cardYear,
                       c.parallel, c.source, c.playerName, c.cardNumber
                FROM c
                WHERE c.setKey = @sk AND c.cardYear = @yr
                  AND STARTSWITH(c.source ?? '', @src)
                  AND LOWER(TRIM(c.parallel ?? '')) = 'base'`,
        parameters: [
          { name: "@sk", value: g.setKey },
          { name: "@yr", value: g.cardYear },
          { name: "@src", value: SOURCE_ROOT },
        ],
      },
      { enableCrossPartitionQuery: true },
    ).fetchAll();

    // BELT AND BRACES. The query says it, and inScope() re-asserts it in JS
    // over every returned row — the predicate that decides a write is the one
    // in this file, not one I have to trust a server to have applied.
    const rows = resources.filter(inScope);
    const rejected = resources.length - rows.length;
    perGroup.push({ ...g, got: rows.length, rejected });
    found.push(...rows);
  }

  console.log("group                          year   expected     found");
  console.log("-------------------------------------------------------");
  let mismatched = 0;
  for (const g of perGroup) {
    const flagStr = g.got === g.expect ? "" : "   <-- MISMATCH";
    if (g.got !== g.expect) mismatched++;
    console.log(
      `${g.setKey.padEnd(28)} ${String(g.cardYear)}  ${String(num(g.expect)).padStart(8)}  ${String(num(g.got)).padStart(8)}${flagStr}`,
    );
    if (g.rejected) console.log(`  (${num(g.rejected)} row(s) returned but rejected by the in-process scope check)`);
  }
  console.log("-------------------------------------------------------");
  console.log(`${"TOTAL".padEnd(33)}  ${String(num(TOTAL_EXPECT)).padStart(8)}  ${String(num(found.length)).padStart(8)}\n`);

  // The audit is the evidence. If the pool no longer matches it, the scope
  // does not describe what it claims to and the write does not proceed.
  if (EXPECT !== "" && found.length !== Number(EXPECT)) {
    console.error(`FATAL: --expect=${EXPECT} but matched ${found.length}. Refusing.`);
    process.exit(3);
  }
  if (APPLY && mismatched) {
    console.error(`FATAL: ${mismatched} group(s) do not match their audited count.`);
    console.error("       Re-audit before applying — a drifted group is not the group that was verified.");
    process.exit(3);
  }
  if (!found.length) { console.log("nothing to do."); return; }

  for (const r of found.slice(0, 8)) {
    console.log(`  ${r.hobbyiqCardId}  #${r.cardNumber}  ${r.playerName}  [${r.source}]`);
  }
  if (found.length > 8) console.log(`  … and ${num(found.length - 8)} more`);

  if (!APPLY) {
    console.log(`\n(dry-run; would blank the parallel field on ${num(found.length)} rows)`);
    console.log("re-dispatch with apply=true to write.");
    return;
  }

  const c = { intended: found.length, written: 0, skipped: 0, failed: 0 };
  await pool(found, CONCURRENCY, async (r) => {
    try {
      // /cardId is the partition key. The helper keeps /parallelBefore, so the
      // previous value survives for reversal, and a row whose value already
      // matches comes back "noop" — declared as skipped, never as loss.
      const res = await patchCatalogRowFields(cat, r.id, r.cardId, { parallel: "" });
      if (res.action === "patch") c.written++;
      else c.skipped++;
    } catch (e) {
      c.failed++;
      if (c.failed <= 5) console.error(`  FAILED ${r.id}: ${String(e.message).slice(0, 140)}`);
    }
  });

  console.log("");
  console.log(`[counters] intended=${num(c.intended)}  blanked=${num(c.written)}  alreadyBlank=${num(c.skipped)}  failed=${num(c.failed)}`);

  // RECONCILIATION, through the one helper: intended = written + skipped + failed.
  // A "noop" is a real, deliberate outcome (the row was already blank), so it
  // is DECLARED as skipped rather than quietly counted as a write — a wrong
  // `intended` turns a real shortfall green.
  reportWrites({
    job: "repair-hobbymonitor-literal-base",
    intended: c.intended,
    written: c.written,
    skipped: c.skipped,
    failed: c.failed,
  });

  // No budget clock and no marker: the scope is six audited groups totalling
  // 1,075 rows, which finishes far inside one step. A marker with no relaunch
  // step would be a fleet that stops silently, green.
  console.log(`\n[done] ${num(c.written)} rows now state no finish, because hobbymonitor stated none.`);
}

module.exports = { isLiteralBase, inScope, GROUPS, TOTAL_EXPECT, isHobbyMonitorScope, SOURCE_ROOT };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

// CF-CATALOG-CARDYEAR-BACKFILL (Drew, 2026-08-10).
// Root cause: BCP ingest wrote `year` but the rest of the codebase reads
// `cardYear` (707 references across 234 files). 1.3M+ BCP rows shipped
// without cardYear, so every downstream query filtering by
// `WHERE c.cardYear = YYYY` bypasses them. Same risk for sold_comps →
// catalog joins on (playerName, cardYear, setName).
//
// Fix: extract year from the hobbyiqCardId slug (position 2 after
// splitting on ':') and add `cardYear` as a top-level field via
// Cosmos patch operation. Idempotent — only writes rows missing
// cardYear.
//
// Ingest itself already fixed at backend/scripts/ingestBaseballCardPedia.cjs
// so future writes carry cardYear. This script cleans up existing rows.
//
// ── CF-CARDYEAR-IS-A-MIRROR, THE STORED HALF (2026-09-04) ──────────────────
//
// #1769 fixed the READER (`(c.cardYear = @y OR c.year = @y)`) and the WRITER
// (deriveCatalogEntry / the checklist ingest dual-write). Neither reaches a row
// already stored. Measured read-only against prod on 2026-09-04, 2,100,230 rows
// carry `year` and no `cardYear`, and every consumer that still filters on
// cardYear alone misses all of them:
//
//     1,521,172  baseballcardpedia-ladders-2026-09-04
//       373,603  hobbymonitor-2026-09-04
//       205,013  sportscardchecklist-2026-09-04
//           423  tcgdex-ja-2026-09-04
//            14  ingest-auto-seed
//             4  ingest-auto-seed-graded
//             1  user-verified
//
// THE RULING (Drew, 2026-09-04): stamp cardYear on EVERY row whose slug carries
// a year, regardless of source. `cardYear` is a MIRROR of the identity year in
// the slug, never a second fact and never an assertion about the card -- so a
// mirror that is present on a checklist row and absent on a vendor row is a
// mirror that is inconsistent, and the inconsistency is the whole defect. This
// is why NO source is excluded: a derived row that is invisible to a cardYear
// filter is a row whose derivedness cannot even be measured. The field asserts
// nothing about authority; `source` still decides that, everywhere, unchanged.
//
// The only rows this leaves alone are rows whose SLUG has no year to mirror --
// they are counted as `skipped`, never guessed at.
//
// Usage (local, report only):
//   DRY_RUN=true  node backend/scripts/backfillCatalogCardYearFromSlug.cjs
// Via the backfill runner: `apply` drives BACKFILL_APPLY, and `sources`
// carries the source scope (comma-separated; empty = every source).

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW (D18, 2026-08-29). Counters, disjoint:
//   intended = rows scanned
//   written  = patches acknowledged
//   skipped  = rows whose slug yields no year (left alone)
//   failed   = patches rejected
// Requires dist/ — the workflow builds before running this.
const { reportWrites } = require(path.join(__dirname, "..", "dist/services/ops/writeReconciliation.js"));
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1765). The runner exports
// slot=0/slots=16 to EVERY script; this one sweeps a population once, so
// sharding is OPT-IN and the banner says which it is doing.
const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const crypto = require("crypto");

const CONN = process.env.COSMOS_CONNECTION_STRING;

// CF-RUNNER-EXPORTS-BACKFILL-APPLY-NOT-APPLY. The runner sets BACKFILL_APPLY
// from its `apply` boolean and never sets DRY_RUN, so a script reading DRY_RUN
// alone defaults to true and an APPLY dispatch silently reports. Both are read,
// and REPORT is the default of each: an apply has to be asked for.
const APPLY = String(process.env.BACKFILL_APPLY ?? "").trim().toLowerCase() === "true"
  || String(process.env.APPLY ?? "").trim().toLowerCase() === "true";
const DRY_RUN_ENV = String(process.env.DRY_RUN ?? "").trim().toLowerCase();
const DRY_RUN = DRY_RUN_ENV === "false" ? false : (DRY_RUN_ENV === "true" ? true : !APPLY);

// The source scope rides SOURCES -- the runner's existing `sources` input,
// already exported to every script -- so no new workflow_dispatch input is
// claimed (the form is at 24 of GitHub's 25). SOURCE_FILTER is kept as the
// local-operator spelling this script shipped with. Empty = EVERY source,
// which is the ruling above.
const SOURCES = String(process.env.SOURCES || process.env.SOURCE_FILTER || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || process.env.CONCURRENCY || 64);

const SHARD_SCOPE = runnerShardScope({ label: "backfillCatalogCardYearFromSlug" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

function yearFromSlug(slug) {
  if (typeof slug !== "string") return null;
  const parts = slug.split(":");
  if (parts.length < 3 || parts[0] !== "hiq") return null;
  const year = Number(parts[2]);
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null;
  return year;
}

const shardOf = (id) =>
  parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % (SLOTS || 1);

/** The MISSING-cardYear predicate, in one place: the scan and the verify-by-read
 *  must ask the same question or the before/after numbers are not comparable. */
const MISSING_WHERE = "IS_DEFINED(c.hobbyiqCardId) AND (NOT IS_DEFINED(c.cardYear) OR c.cardYear = null)";

function sourceClause(alias) {
  if (SOURCES.length === 0) return "";
  const list = SOURCES.map((s) => JSON.stringify(String(s))).join(", ");
  return ` AND ${alias}.source IN (${list})`;
}

/** VERIFY BY READ (CF-GREEN-WORKFLOW-IS-NOT-DATA-FLOW). The banner cannot
 *  certify the write; a COUNT per source, taken before and after, can. */
async function countMissingBySource(cat) {
  const q = `SELECT c.source, COUNT(1) AS n FROM c WHERE ${MISSING_WHERE}${sourceClause("c")} GROUP BY c.source`;
  const rows = (await cat.items.query({ query: q }, { maxItemCount: 5000 }).fetchAll()).resources;
  const out = new Map();
  for (const r of rows) out.set(r.source ?? "(none)", r.n);
  return out;
}

function printCounts(label, counts) {
  const entries = [...counts].sort((a, b) => b[1] - a[1]);
  let total = 0;
  console.log(`  ${label}`);
  for (const [src, n] of entries) { total += n; console.log(`    ${String(n).padStart(10)}  ${src}`); }
  console.log(`    ${String(total).padStart(10)}  TOTAL`);
  return total;
}

async function main() {
  if (!CONN) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const client = new CosmosClient(CONN);
  const cat = client.database("hobbyiq").container("card_catalog");
  const t0 = Date.now();

  console.log("");
  console.log("=== backfillCatalogCardYearFromSlug ===");
  console.log(`  mode                 : ${DRY_RUN ? "REPORT-ONLY (no writes)" : "APPLY"}`);
  console.log(`  source scope         : ${SOURCES.length ? SOURCES.join(", ") : "EVERY source (the ruling: a mirror is source-agnostic)"}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log("");

  console.log("[verify-by-read] BEFORE — rows missing cardYear, per source:");
  const before = await countMissingBySource(cat);
  const beforeTotal = printCounts("before:", before);
  console.log("");

  const query = `SELECT c.id, c.cardId, c.hobbyiqCardId, c.source FROM c WHERE ${MISSING_WHERE}${sourceClause("c")}`;
  console.log("[scan] querying:");
  console.log("  ", query);

  const iter = cat.items.query(query, { maxItemCount: 1000 });
  let scanned = 0, planned = 0, skippedBadSlug = 0, skippedOtherShard = 0;
  const patchQueue = [];
  const plannedBySource = new Map();

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      scanned++;
      if (SHARDED && shardOf(r.id) !== SLOT) { skippedOtherShard++; continue; }
      const y = yearFromSlug(r.hobbyiqCardId);
      if (!y) { skippedBadSlug++; continue; }
      patchQueue.push({ id: r.id, pk: r.cardId ?? r.id, year: y });
      const s = r.source ?? "(none)";
      plannedBySource.set(s, (plannedBySource.get(s) || 0) + 1);
      planned++;
    }
    if (scanned % 100000 === 0) console.log(`  scanned=${scanned.toLocaleString()}  planned=${planned.toLocaleString()}  skipped=${(skippedBadSlug + skippedOtherShard).toLocaleString()}`);
  }

  console.log("");
  console.log("[plan]");
  console.log(`  rows scanned         : ${scanned.toLocaleString()}`);
  console.log(`  patches planned      : ${planned.toLocaleString()}`);
  console.log(`  skipped (bad slug)   : ${skippedBadSlug.toLocaleString()}`);
  if (SHARDED) console.log(`  skipped (other shard): ${skippedOtherShard.toLocaleString()}`);
  if (plannedBySource.size > 0) {
    console.log("  planned per source   :");
    for (const [s, n] of [...plannedBySource].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(10)}  ${s}`);
    }
  }
  if (patchQueue.length > 0) {
    const yearCounts = new Map();
    for (const p of patchQueue) yearCounts.set(p.year, (yearCounts.get(p.year) || 0) + 1);
    const yearsSorted = [...yearCounts.entries()].sort((a, b) => a[0] - b[0]);
    console.log(`  year span            : ${yearsSorted[0][0]} - ${yearsSorted[yearsSorted.length - 1][0]}  (${yearsSorted.length} distinct years)`);
    console.log(`  top years            :`);
    const topYears = [...yearCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    for (const [y, n] of topYears) console.log(`    ${y}: ${n.toLocaleString()}`);
  }

  let patched = 0, patchFailed = 0;

  if (DRY_RUN) {
    console.log("");
    console.log("[REPORT-ONLY] no writes issued. Re-dispatch with apply=true to apply.");
  } else {
    console.log("");
    console.log("[apply] patching…");
    const inflight = new Set();
    for (const p of patchQueue) {
      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      const task = cat.item(p.id, p.pk).patch([
        { op: "add", path: "/cardYear", value: p.year },
      ])
        .then(() => {
          patched++;
          if (patched % 25000 === 0) {
            const eps = (patched / ((Date.now() - t0) / 1000)).toFixed(0);
            console.log(`  patched ${patched.toLocaleString()}/${planned.toLocaleString()}  (${eps}/sec)`);
          }
        })
        .catch((err) => {
          patchFailed++;
          if (patchFailed <= 10) console.warn(`  patch-fail id=${p.id} pk=${p.pk}: ${(err && err.message) || err}`);
        })
        .finally(() => inflight.delete(task));
      inflight.add(task);
    }
    await Promise.all([...inflight]);
  }

  console.log("");
  console.log("[verify-by-read] AFTER — rows missing cardYear, per source:");
  const after = await countMissingBySource(cat);
  const afterTotal = printCounts("after:", after);
  console.log("");
  console.log(`  moved: ${(beforeTotal - afterTotal).toLocaleString()} rows left the missing-cardYear population`);
  if (DRY_RUN && afterTotal !== beforeTotal) {
    console.log("  (a REPORT-ONLY run wrote nothing; any delta here is another writer — the nightly ingest — landing rows mid-run.)");
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log("[done]");
  console.log(`  patched        : ${patched.toLocaleString()}`);
  console.log(`  patch-failed   : ${patchFailed.toLocaleString()}`);
  console.log(`  elapsed        : ${elapsed}s`);

  // RECONCILIATION. intended = written + skipped + failed, exactly. In a
  // REPORT-ONLY run every planned row is a skip: nothing was written, and
  // saying "intended 2.1M, written 0" with no skip column is how an
  // under-sweep reads as a success.
  const skipped = skippedBadSlug + skippedOtherShard
    + (DRY_RUN ? planned : (planned - patched - patchFailed));
  reportWrites({
    job: "backfillCatalogCardYearFromSlug",
    intended: scanned,
    written: patched,
    skipped,
    failed: patchFailed,
  });
}

module.exports = { yearFromSlug, shardOf, SHARDED, SLOT, SLOTS, DRY_RUN, APPLY, SOURCES, MISSING_WHERE, sourceClause };

if (require.main === module) {
  main().catch((e) => { console.error("[FATAL]", (e && e.stack) || e); process.exit(1); });
}

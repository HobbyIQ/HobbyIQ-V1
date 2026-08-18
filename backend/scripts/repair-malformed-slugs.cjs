#!/usr/bin/env node
/**
 * CF-REPAIR-MALFORMED-SLUGS (Drew, 2026-08-18: "let's make the fixes here,
 * this is important").
 *
 * Repairs slugs that are structurally invalid — not mis-filed onto the wrong
 * product, but shaped so they can never match ANY card. Found by
 * audit-identity-splits.cjs while chasing two reported pricing bugs.
 *
 * THREE CLASSES, THREE DIFFERENT REPAIRS, because they fail differently:
 *
 * 1. `variant::` PREFIX  (57 rows)  -> NULL the slug
 *    e.g. variant::hiq:baseball:2024:topps-chrome-black:85:refractor:no-auto:num-199
 *         setName "bowman-chrome-sapphire", title "2024 Bowman Chrome Sapphire #85 Yellow Refractor"
 *    A prefix leaked in from a variant-handling path. 56 of 57 sampled rows
 *    ALSO carry a setKey that contradicts their own setName, so the slug is
 *    not merely malformed, it names the wrong card. These are low-count and
 *    HIGH-PRICE ($42,090 Topps Heritage sale filed under bare `topps`;
 *    $7,140 Mega Box filed under `bowman-chrome`), which is the worst
 *    combination: a handful of rows able to drag a whole pool's projection.
 *
 * 2. EMPTY SEGMENT  (6,043 rows)  -> NULL the slug
 *    e.g. hiq:baseball:2025:::base:no-auto  (blank setKey AND blank cardNumber)
 *    Mostly cardsight rows whose setName and cardNumber are both "". The slug
 *    is unreachable, so the sale is lost rather than misapplied.
 *
 * 3. NON-NUMERIC PRINT-RUN SEGMENT  (2,952 rows)  -> STRIP that segment
 *    e.g. hiq:baseball:2024:panini-prizm:357:base:no-auto:bgs-10
 *    A GRADE leaked into the print-run slot. Here the first seven segments are
 *    correct, so nulling would throw away good identity. Dropping the invalid
 *    tail merges the row into the pool it always belonged to.
 *
 * WHY NULL AND NOT GUESS. slugGuard's doctrine is that an ABSENT slug is
 * strictly better than a WRONG one. A nulled row is re-derived by the nightly
 * backfill from its own fields, through the same resolver ingest uses. If the
 * fields are too thin the guard refuses and the row stays null — which is the
 * correct outcome, not a failure. Reconstructing identity from `title` is
 * explicitly NOT done: title is untrusted parser input, and guessing from it
 * would write rows on evidence we would not accept at ingest.
 *
 * hobbyiqCardIdBefore records the original on every class, so any pass is
 * reversible.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/repair-malformed-slugs.cjs \
 *     [--class=variant|empty|printrun|all] [--apply] [--pool=12] [--limit=N]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const has = (n) => process.argv.includes(`--${n}`);
const CLASS = arg("class", "all");
const POOL = Math.max(1, Number(arg("pool", "12")));
const LIMIT = Number(arg("limit", "0")) || Infinity;
const APPLY = has("apply");

/** Returns the repair for a slug, or null if it is well formed. */
function planRepair(slug) {
  const s = String(slug ?? "");
  if (!s) return null;

  if (s.startsWith("variant::")) {
    return { cls: "variant", action: "null", next: null };
  }

  const p = s.split(":");
  if (p.length < 7) return { cls: "empty", action: "null", next: null };

  // Segments 1..6 are sport, year, setKey, cardNumber, parallel, auto.
  if (p.slice(1, 7).some((seg) => seg === "")) {
    return { cls: "empty", action: "null", next: null };
  }

  // A well-formed slug is 7 segments, optionally 8 with a print run. Segment 7
  // must be num-N; segment 8 and beyond must not exist at all.
  //
  // The first cut of this checked only p[7] and missed the commonest form,
  // because the grade is APPENDED AFTER a valid print run:
  //
  //   hiq:baseball:2015:panini-prizm:87:blue-prizm:no-auto:num-75:bgs-10
  //                                                       ^valid^ ^grade^
  //
  // p[7] is "num-75" and passes, so 188 rows survived the first pass. Keep
  // whatever prefix is valid and drop the rest: if p[7] is a real print run it
  // is identity worth keeping, otherwise cut back to the 7-segment core.
  const keep = /^num-\d+$/.test(p[7] ?? "") ? 8 : 7;
  if (p.length > keep) {
    return { cls: "printrun", action: "strip", next: p.slice(0, keep).join(":") };
  }
  return null;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[repair-malformed-slugs] class=${CLASS} mode=${APPLY ? "APPLY" : "DRY-RUN"} pool=${POOL}\n`);

  // Narrow server-side so this never scans the whole container. The planner
  // re-checks every row, so a loose filter cannot cause a wrong repair — but
  // it does cost RU, and the first version cost far too much: `ENDSWITH(...,
  // "-10")` also matches the perfectly valid print run `:num-10`, so the query
  // dragged in a large slice of the container and timed out once sold_comps
  // was back at its 8000 idle ceiling.
  //
  // Match the GRADE TOKEN instead. A print-run segment is always `num-N`, so
  // ":bgs-", ":psa-", ":sgc-", ":cgc-" and ":raw" cannot collide with one.
  const iter = sold.items.query(
    `SELECT c.id, c.cardId, c.hobbyiqCardId FROM c
      WHERE IS_DEFINED(c.hobbyiqCardId) AND NOT IS_NULL(c.hobbyiqCardId)
        AND (CONTAINS(c.hobbyiqCardId, "::")
             OR CONTAINS(c.hobbyiqCardId, ":raw")
             OR CONTAINS(c.hobbyiqCardId, ":bgs-")
             OR CONTAINS(c.hobbyiqCardId, ":psa-")
             OR CONTAINS(c.hobbyiqCardId, ":sgc-")
             OR CONTAINS(c.hobbyiqCardId, ":cgc-"))`,
    { maxItemCount: 1000 },
  );

  const counts = { variant: 0, empty: 0, printrun: 0 };
  let scanned = 0, repaired = 0, failed = 0;

  while (iter.hasMoreResults() && scanned < LIMIT) {
    const { resources } = await iter.fetchNext();
    const work = [];
    for (const r of resources || []) {
      if (scanned >= LIMIT) break;
      scanned++;
      const plan = planRepair(r.hobbyiqCardId);
      if (!plan) continue;
      if (CLASS !== "all" && CLASS !== plan.cls) continue;
      counts[plan.cls]++;
      work.push({ r, plan });
    }

    let cursor = 0;
    await Promise.all(Array.from({ length: POOL }, async () => {
      while (cursor < work.length) {
        const { r, plan } = work[cursor++];
        if (!APPLY) { repaired++; continue; }
        try {
          await sold.item(r.id, r.cardId).patch([
            { op: "add", path: "/hobbyiqCardIdBefore", value: r.hobbyiqCardId },
            { op: "set", path: "/hobbyiqCardId", value: plan.next },
          ]);
          repaired++;
        } catch (e) {
          failed++;
          if (failed <= 5) console.log(`   patch failed ${r.id}: ${String(e.message).slice(0, 80)}`);
        }
      }
    }));
    if (scanned % 20000 < 1000) process.stderr.write(`\r  scanned=${scanned} repaired=${repaired}   `);
  }
  process.stderr.write("\n");

  console.log(`\nby class:`);
  console.log(`   ${String(counts.variant).padStart(6)}  variant:: prefix        -> slug NULLED (backfill re-derives)`);
  console.log(`   ${String(counts.empty).padStart(6)}  empty segment           -> slug NULLED (backfill re-derives)`);
  console.log(`   ${String(counts.printrun).padStart(6)}  grade in print-run slot -> invalid tail STRIPPED`);
  console.log(`\nscanned=${scanned} repaired=${repaired} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
